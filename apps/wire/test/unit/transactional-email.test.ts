import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import {
  ALLOWED_EMAIL_CLASSES,
  assertEmailContentSafe,
  createResendFetchTransport,
  drainTransactionalEmailOutbox,
  mintSignedAgoraActionUrl,
  prepareEnqueueTransactionalEmail,
  readEmailOutboxHealth,
  reconcileTransactionalEmailOutbox,
  renderTransactionalEmail,
  setSponsorDigestPreference,
  TransactionalEmailPolicyError,
  verifySignedAgoraActionToken,
} from "../../src/email/transactional-email.ts";
import type { Env } from "../../src/env.ts";
import { sponsorAccountDeletionStatements } from "../../src/krater/retention.ts";
import { migratedSqliteD1 } from "../support/migrated-sqlite.ts";

const AGORA = "https://asimposium.org";
const LINK_SECRET = "ops7-test-hmac-link-secret-32-bytes";
const SPONSOR_ID = "usr_ops7_sponsor_1";
const RECIPIENT = "sponsor.ops7@example.org";

describe("OPS.7 Minimal Transactional Email via D1 Outbox (asimposiumorg-d5x)", () => {
  test("renders all 4 allowed classes with accessible HTML + plain-text alternatives and signed host-only Agora links, and refuses forbidden classes/secrets/fragments", async () => {
    for (const emailClass of ALLOWED_EMAIL_CLASSES) {
      const rendered = await renderTransactionalEmail({
        emailClass,
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: `Test ${emailClass} notice`,
        referenceId: `REF-${emailClass}`,
        occurredAtIso: "2026-11-22T05:00:00.000Z",
      });
      expect(rendered.subject).toContain(`REF-${emailClass}`);
      expect(rendered.actionUrl.startsWith(`${AGORA}/console?`)).toBe(true);
      expect(rendered.actionUrl).toContain("sig=");
      expect(rendered.actionUrl).not.toContain("#");
      // Accessibility & plain-text parity
      expect(rendered.htmlBody).toContain('<html lang="en">');
      expect(rendered.htmlBody).toContain('role="main"');
      expect(rendered.htmlBody).toContain("<h1 ");
      expect(rendered.textBody).toContain(rendered.actionUrl);
      if (emailClass === "opt_in_digest") {
        expect(rendered.listUnsubscribeUrl?.startsWith(`${AGORA}/`)).toBe(true);
        expect(rendered.textBody).toContain("Unsubscribe immediately");
        expect(rendered.htmlBody).toContain("Unsubscribe immediately");
      } else {
        expect(rendered.listUnsubscribeUrl).toBeUndefined();
      }
    }

    // Forbidden class refused
    await expect(
      renderTransactionalEmail({
        emailClass: "per_event_follower_alert" as never,
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "New claim posted",
        referenceId: "REF-FORBIDDEN",
        occurredAtIso: "2026-11-22T05:00:00.000Z",
      }),
    ).rejects.toThrow(TransactionalEmailPolicyError);

    // Enrollment fragment, Fellow bearer token, flow handle, policy detector, and untrusted origin ALL refused!
    const badInputs = [
      { summaryLabel: `Join https://a.asimposium.org/join/ASIMP-EN-1234#v1.${"Q".repeat(43)}` },
      { summaryLabel: `Bearer asimp_ag_${"0123456789ABCDEFGHJKMNPQRS"}_${"a".repeat(43)}` },
      { summaryLabel: `Poll flow_v1.${"r".repeat(43)}` },
      { summaryLabel: "Blocked by acip_rule_prompt_override_v2" },
      { summaryLabel: "WORKSHOP_PRIVATE_DRAFT_EXCERPT" },
      { agoraOrigin: "https://evil.example.com" },
      { actionPath: "/console#v1.secretfragment" },
    ];
    for (const override of badInputs) {
      await expect(
        renderTransactionalEmail({
          emailClass: "enrollment_approval",
          sponsorId: SPONSOR_ID,
          agoraOrigin: override.agoraOrigin ?? AGORA,
          actionPath: override.actionPath ?? "/console",
          linkSecret: LINK_SECRET,
          summaryLabel: override.summaryLabel ?? "Pending Fellow",
          referenceId: "REF-BAD",
          occurredAtIso: "2026-11-22T05:00:00.000Z",
        }),
      ).rejects.toThrow(TransactionalEmailPolicyError);
    }
  });

  test("real loopback Resend HTTP transport: atomic D1 enqueue, duplicate idempotency, immediate digest unsubscribe (preserving security/moderation alerts), retry/backoff -> dead-letter, provider outage resilience, and spend caps", async () => {
    const { db, sqlite } = migratedSqliteD1();
    const receivedRequests: Array<{
      idempotencyKey: string | null;
      body: Record<string, unknown>;
    }> = [];
    let serverMode: "ok" | "outage-503" = "ok";
    let msgSerial = 0;

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        receivedRequests.push({
          idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
          body: parsed,
        });
        if (serverMode === "outage-503") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "service_unavailable" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `re_msg_${++msgSerial}` }));
      });
    });

    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const port = (server.address() as { port: number }).port;
    const transport = createResendFetchTransport({
      apiKey: "re_test_synthetic_key_ops7",
      endpoint: `http://127.0.0.1:${port}/emails`,
    });

    try {
      const t0 = Date.parse("2026-11-22T05:00:00.000Z");
      const nowIso = new Date(t0).toISOString();
      const resolveRecipientEmail = async () => RECIPIENT;

      // 1. Atomic D1 batch enqueue + duplicate idempotency key deduplication
      const enrollMail = await renderTransactionalEmail({
        emailClass: "enrollment_approval",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Fellow alpha-verifier requested approval",
        referenceId: "EN-001",
        occurredAtIso: nowIso,
      });
      const stmt1 = await prepareEnqueueTransactionalEmail(db, {
        idempotencyKey: "email:enroll:EN-001",
        causalEventId: null,
        sponsorId: SPONSOR_ID,
        recipientEmail: RECIPIENT,
        rendered: enrollMail,
        agoraOrigin: AGORA,
        nowIso,
      });
      const stmt1Dup = await prepareEnqueueTransactionalEmail(db, {
        idempotencyKey: "email:enroll:EN-001",
        causalEventId: null,
        sponsorId: SPONSOR_ID,
        recipientEmail: RECIPIENT,
        rendered: enrollMail,
        agoraOrigin: AGORA,
        nowIso,
      });
      await db.batch([stmt1, stmt1Dup]);

      const d1 = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0,
      });
      expect(d1.delivered).toBe(1);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]?.idempotencyKey).toBe("email:enroll:EN-001");

      // Re-draining delivers 0 duplicates
      const d1Again = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 1_000,
      });
      expect(d1Again.delivered).toBe(0);
      expect(receivedRequests).toHaveLength(1);

      // 2. Opt-in digest: default OFF suppresses; opt-in delivers; immediate unsubscribe suppresses pending digest WITHOUT touching security_alert / moderation_notice!
      const digest1 = await renderTransactionalEmail({
        emailClass: "opt_in_digest",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Weekly digest: 2 active problems",
        referenceId: "DIGEST-1",
        occurredAtIso: nowIso,
      });
      await (
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:digest:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: digest1,
          agoraOrigin: AGORA,
          nowIso,
        })
      ).run();
      const dSuppressedDefault = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 2_000,
      });
      expect(dSuppressedDefault.suppressedUnsubscribed).toBe(1);
      expect(dSuppressedDefault.delivered).toBe(0);

      // Opt-in -> digest delivers!
      await setSponsorDigestPreference(db, { sponsorId: SPONSOR_ID, optIn: true, nowIso });
      await (
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:digest:2",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: digest1,
          agoraOrigin: AGORA,
          nowIso,
        })
      ).run();
      const dOptedIn = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 3_000,
      });
      expect(dOptedIn.delivered).toBe(1);
      const digestReq = receivedRequests.find((r) => r.idempotencyKey === "email:digest:2");
      const digestHeaders = digestReq?.body.headers as Record<string, string> | undefined;
      expect(digestHeaders?.["List-Unsubscribe"]).toContain(AGORA);
      expect(digestHeaders?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

      // Queue digest3 + security_alert + moderation_notice, then immediately unsubscribe -> digest3 suppressed, security & moderation STILL delivered!
      const secMail = await renderTransactionalEmail({
        emailClass: "security_alert",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Fellow credential revoked",
        referenceId: "SEC-1",
        occurredAtIso: nowIso,
      });
      const modMail = await renderTransactionalEmail({
        emailClass: "moderation_notice",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console/appeals",
        linkSecret: LINK_SECRET,
        summaryLabel: "Appeal decision recorded",
        referenceId: "MOD-1",
        occurredAtIso: nowIso,
      });
      await db.batch([
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:digest:3",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: digest1,
          agoraOrigin: AGORA,
          nowIso,
        }),
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:sec:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: secMail,
          agoraOrigin: AGORA,
          nowIso,
        }),
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:mod:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: modMail,
          agoraOrigin: AGORA,
          nowIso,
        }),
      ]);
      await setSponsorDigestPreference(db, { sponsorId: SPONSOR_ID, optIn: false, nowIso });
      const dAfterUnsub = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 4_000,
      });
      expect(dAfterUnsub.delivered).toBe(2);

      // 3. Provider outage (503) -> bounded retry/backoff -> visible dead_letter + operator alert (NEVER throws!)
      serverMode = "outage-503";
      await (
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:outage:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: secMail,
          agoraOrigin: AGORA,
          nowIso,
          maxAttempts: 2,
        })
      ).run();
      const attempt1 = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 5_000,
      });
      expect(attempt1.retried).toBe(1);
      expect(attempt1.deadLettered).toBe(0);

      // Advance past 30s exponential backoff -> attempt 2 dead-letters & emits EMAIL_DEAD_LETTERED alert!
      const attempt2 = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 40_000,
      });
      expect(attempt2.deadLettered).toBe(1);
      expect(attempt2.alerts.some((a) => a.code === "EMAIL_DEAD_LETTERED")).toBe(true);

      // 4. Spend cap enforcement & alert
      serverMode = "ok";
      await (
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:cap:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: secMail,
          agoraOrigin: AGORA,
          nowIso,
        })
      ).run();
      const capDrain = await drainTransactionalEmailOutbox(db, {
        transport,
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        resolveRecipientEmail,
        nowMs: t0 + 45_000,
        monthlyCap: 4, // already sent 4 messages above
        warnThreshold: 3,
      });
      expect(capDrain.deferredSpendCap).toBe(1);
      expect(capDrain.alerts.some((a) => a.code === "EMAIL_SPEND_CAP_REACHED")).toBe(true);

      // 5. Health view reflects visible dead-letter & deferred-spend-cap state without leaking recipient email!
      const health = await readEmailOutboxHealth(db);
      expect(health.delivered).toBe(4);
      expect(health.dead_letter).toBe(1);
      expect(health.suppressed_unsubscribed).toBe(2);
      expect(health.deferred_spend_cap).toBe(1);
      expect(health.degraded).toBe(true);

      // Verify raw recipient email is NEVER persisted in `transactional_email_outbox`!
      const outboxDump = JSON.stringify(
        sqlite.prepare("SELECT * FROM transactional_email_outbox").all(),
      );
      expect(outboxDump).not.toContain(RECIPIENT);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sqlite.close();
    }
  });

  test("Wave 8 hardening: malformed agoraOrigin, CRLF headers, weak linkSecret, path traversal, and HMAC verification fail closed", async () => {
    expect(() =>
      assertEmailContentSafe({
        emailClass: "security_alert",
        subject: "Security alert",
        textBody: "Body",
        htmlBody: "<p>Body</p>",
        actionUrl: "https://asimposium.org/console",
        agoraOrigin: "not-a-valid-url",
      }),
    ).toThrow(TransactionalEmailPolicyError);

    await expect(
      mintSignedAgoraActionUrl({
        agoraOrigin: AGORA,
        actionPath: "/console/../admin",
        sponsorId: SPONSOR_ID,
        referenceId: "REF-1",
        linkSecret: LINK_SECRET,
      }),
    ).rejects.toThrow(TransactionalEmailPolicyError);

    await expect(
      mintSignedAgoraActionUrl({
        agoraOrigin: AGORA,
        actionPath: "/console?evil=1",
        sponsorId: SPONSOR_ID,
        referenceId: "REF-1",
        linkSecret: LINK_SECRET,
      }),
    ).rejects.toThrow(TransactionalEmailPolicyError);

    await expect(
      mintSignedAgoraActionUrl({
        agoraOrigin: AGORA,
        actionPath: "/console",
        sponsorId: SPONSOR_ID,
        referenceId: "REF-1",
        linkSecret: "too-short",
      }),
    ).rejects.toThrow(TransactionalEmailPolicyError);

    const { db, sqlite } = migratedSqliteD1();
    try {
      const rendered = await renderTransactionalEmail({
        emailClass: "security_alert",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Credential rotated",
        referenceId: "SEC-CRLF",
        occurredAtIso: "2026-11-22T05:00:00.000Z",
      });
      await expect(
        prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:crlf:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: "bad@example.org\r\nBcc: evil@example.org",
          rendered,
          agoraOrigin: AGORA,
          nowIso: "2026-11-22T05:00:00.000Z",
        }),
      ).rejects.toThrow(TransactionalEmailPolicyError);

      await expect(
        drainTransactionalEmailOutbox(db, {
          transport: { send: async () => ({ ok: true, providerMessageId: "m1" }) },
          fromAddress: "ASImposium <notices@asimposium.org>\r\nBcc: evil@example.org",
          agoraOrigin: AGORA,
          resolveRecipientEmail: async () => RECIPIENT,
        }),
      ).rejects.toThrow(TransactionalEmailPolicyError);

      const signedUrl = await mintSignedAgoraActionUrl({
        agoraOrigin: AGORA,
        actionPath: "/console/email-preferences/unsubscribe",
        sponsorId: SPONSOR_ID,
        referenceId: `unsub-${SPONSOR_ID}`,
        linkSecret: LINK_SECRET,
      });
      const sig = new URL(signedUrl).searchParams.get("sig") ?? "";
      expect(
        await verifySignedAgoraActionToken({
          sponsorId: SPONSOR_ID,
          actionPath: "/console/email-preferences/unsubscribe",
          referenceId: `unsub-${SPONSOR_ID}`,
          sig,
          linkSecret: LINK_SECRET,
        }),
      ).toBe(true);
      expect(
        await verifySignedAgoraActionToken({
          sponsorId: "usr_other_sponsor",
          actionPath: "/console/email-preferences/unsubscribe",
          referenceId: `unsub-${SPONSOR_ID}`,
          sig,
          linkSecret: LINK_SECRET,
        }),
      ).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("Wave 8 concurrency: overlapping drainer runs claim an atomic delivery lease so one row sends and counts spend exactly once", async () => {
    const { db, sqlite } = migratedSqliteD1();
    let sendCalls = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        sendCalls += 1;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `re_conc_${sendCalls}` }));
        }, 30);
      });
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const port = (server.address() as { port: number }).port;
    const transport = createResendFetchTransport({
      apiKey: "re_test_concurrent",
      endpoint: `http://127.0.0.1:${port}/emails`,
    });

    try {
      const nowMs = Date.parse("2026-11-23T01:00:00.000Z");
      const nowIso = new Date(nowMs).toISOString();
      const rendered = await renderTransactionalEmail({
        emailClass: "security_alert",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Panic key activated",
        referenceId: "CONC-1",
        occurredAtIso: nowIso,
      });
      await (
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:conc:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered,
          agoraOrigin: AGORA,
          nowIso,
        })
      ).run();

      const [r1, r2] = await Promise.all([
        drainTransactionalEmailOutbox(db, {
          transport,
          fromAddress: "ASImposium <notices@asimposium.org>",
          agoraOrigin: AGORA,
          resolveRecipientEmail: async () => RECIPIENT,
          nowMs,
        }),
        drainTransactionalEmailOutbox(db, {
          transport,
          fromAddress: "ASImposium <notices@asimposium.org>",
          agoraOrigin: AGORA,
          resolveRecipientEmail: async () => RECIPIENT,
          nowMs,
        }),
      ]);

      expect(sendCalls).toBe(1);
      expect(r1.delivered + r2.delivered).toBe(1);
      const spend = sqlite
        .prepare("SELECT sent_count FROM email_spend_counters WHERE month_utc = '2026-11'")
        .get() as { sent_count: number };
      expect(spend.sent_count).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sqlite.close();
    }
  });

  test("Wave 8 runtime wiring: mounted Stoa email routes, RFC 8058 signed unsubscribe, cron reconcile no-op, and atomic account-deletion purge", async () => {
    const { db, sqlite } = migratedSqliteD1();
    try {
      const OTHER_SPONSOR = "usr_ops7_sponsor_2";
      const OPERATOR = "usr_ops7_operator_1";
      const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair;
      const pubHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
      const replayKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );

      const env = {
        DB: db,
        STOA_ORIGIN: "https://a.asimposium.org",
        AGORA_ORIGIN: AGORA,
        SERVICE_ENVELOPE_KEYS: JSON.stringify([
          { kid: "k-ops7", publicKeyHex: pubHex, notBefore: 0 },
        ]),
        OPERATOR_PRINCIPAL_IDS: OPERATOR,
        ENROLLMENT_REPLAY_KEY: replayKey,
        EMAIL_ACTION_LINK_SECRET: LINK_SECRET,
      } as unknown as Env;

      const app = createApp();

      const signedRequest = async (opts: {
        method: "GET" | "POST";
        path: string;
        action: string;
        principalType: "sponsor" | "operator";
        principalId: string;
        body?: string;
      }) => {
        const body = opts.body ?? "";
        const envelope = await mintServiceEnvelope({
          kid: "k-ops7",
          privateKey: keyPair.privateKey,
          issuer: "agora",
          audience: "stoa",
          principalType: opts.principalType,
          principalId: opts.principalId,
          method: opts.method,
          route: opts.path,
          action: opts.action,
          body,
          now: Math.floor(Date.now() / 1_000),
        });
        return app.fetch(
          new Request(`https://a.asimposium.org${opts.path}`, {
            method: opts.method,
            headers: {
              ...serviceEnvelopeHeaders(envelope),
              ...(opts.method === "POST" ? { "content-type": "application/json" } : {}),
            },
            ...(opts.method === "POST" ? { body } : {}),
          }),
          env,
        );
      };

      // 1. Unauthenticated sponsor preferences read -> 403 WRONG_PRINCIPAL (S-6 service-envelope gate), private, no-store
      const anonPref = await app.fetch(
        new Request("https://a.asimposium.org/v1/sponsors/email-preferences"),
        env,
      );
      expect(anonPref.status).toBe(403);
      expect(anonPref.headers.get("cache-control")).toBe("private, no-store");
      expect(((await anonPref.json()) as { code: string }).code).toBe("WRONG_PRINCIPAL");

      // 2. Authenticated sponsor reads default preferences, updates opt-in + notification email, response NEVER leaks plaintext email!
      const getDefault = await signedRequest({
        method: "GET",
        path: "/v1/sponsors/email-preferences",
        action: "email-preferences.read",
        principalType: "sponsor",
        principalId: SPONSOR_ID,
      });
      expect(getDefault.status).toBe(200);
      expect(getDefault.headers.get("cache-control")).toBe("private, no-store");
      expect(getDefault.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await getDefault.json()).toEqual({
        sponsor_id: SPONSOR_ID,
        digest_opt_in: false,
        digest_unsubscribed_at: null,
        has_notification_email: false,
        updated_at: null,
      });

      const postBadJson = await signedRequest({
        method: "POST",
        path: "/v1/sponsors/email-preferences",
        action: "email-preferences.write",
        principalType: "sponsor",
        principalId: SPONSOR_ID,
        body: "{not-json",
      });
      expect(postBadJson.status).toBe(400);
      expect(((await postBadJson.json()) as { code: string }).code).toBe("MALFORMED_JSON");

      const postBadEmail = await signedRequest({
        method: "POST",
        path: "/v1/sponsors/email-preferences",
        action: "email-preferences.write",
        principalType: "sponsor",
        principalId: SPONSOR_ID,
        body: JSON.stringify({
          digest_opt_in: true,
          notification_email: "not-an-email",
        }),
      });
      expect(postBadEmail.status).toBe(422);
      expect(((await postBadEmail.json()) as { code: string }).code).toBe("SCHEMA_INVALID");

      const postPref = await signedRequest({
        method: "POST",
        path: "/v1/sponsors/email-preferences",
        action: "email-preferences.write",
        principalType: "sponsor",
        principalId: SPONSOR_ID,
        body: JSON.stringify({
          digest_opt_in: true,
          notification_email: RECIPIENT,
        }),
      });
      expect(postPref.status).toBe(200);
      const postPrefText = await postPref.text();
      expect(postPrefText).not.toContain(RECIPIENT);
      const postPrefJson = JSON.parse(postPrefText) as {
        digest_opt_in: boolean;
        has_notification_email: boolean;
      };
      expect(postPrefJson.digest_opt_in).toBe(true);
      expect(postPrefJson.has_notification_email).toBe(true);

      // Enqueue one pending digest + one pending security alert for SPONSOR_ID, and one for OTHER_SPONSOR.
      const nowIso = "2026-11-23T02:00:00.000Z";
      const digestMail = await renderTransactionalEmail({
        emailClass: "opt_in_digest",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Weekly digest metadata",
        referenceId: "DIG-MOUNT-1",
        occurredAtIso: nowIso,
      });
      const secMail = await renderTransactionalEmail({
        emailClass: "security_alert",
        sponsorId: SPONSOR_ID,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Credential event",
        referenceId: "SEC-MOUNT-1",
        occurredAtIso: nowIso,
      });
      const otherSecMail = await renderTransactionalEmail({
        emailClass: "security_alert",
        sponsorId: OTHER_SPONSOR,
        agoraOrigin: AGORA,
        actionPath: "/console",
        linkSecret: LINK_SECRET,
        summaryLabel: "Other sponsor alert",
        referenceId: "SEC-OTHER-1",
        occurredAtIso: nowIso,
      });
      await setSponsorDigestPreference(db, {
        sponsorId: OTHER_SPONSOR,
        optIn: true,
        notificationEmail: "other@example.org",
        nowIso,
      });
      await db.batch([
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:mount:dig:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: digestMail,
          agoraOrigin: AGORA,
          nowIso,
        }),
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:mount:sec:1",
          causalEventId: null,
          sponsorId: SPONSOR_ID,
          recipientEmail: RECIPIENT,
          rendered: secMail,
          agoraOrigin: AGORA,
          nowIso,
        }),
        await prepareEnqueueTransactionalEmail(db, {
          idempotencyKey: "email:mount:other:1",
          causalEventId: null,
          sponsorId: OTHER_SPONSOR,
          recipientEmail: "other@example.org",
          rendered: otherSecMail,
          agoraOrigin: AGORA,
          nowIso,
        }),
      ]);

      // 3. Public signed one-click unsubscribe: tampered sig -> 403; authentic sig -> 200 & suppresses ONLY opt_in_digest!
      const unsubUrl = new URL(digestMail.listUnsubscribeUrl ?? "");
      const ref = unsubUrl.searchParams.get("ref") ?? "";
      const sig = unsubUrl.searchParams.get("sig") ?? "";

      // Oversized public unsubscribe body -> 413 REQUEST_BODY_TOO_LARGE before JSON parsing!
      const oversizedUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sponsor_id: SPONSOR_ID,
            ref,
            sig,
            pad: "x".repeat(4096),
          }),
        }),
        env,
      );
      expect(oversizedUnsub.status).toBe(413);
      expect(((await oversizedUnsub.json()) as { code: string }).code).toBe(
        "REQUEST_BODY_TOO_LARGE",
      );

      const forgedUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sponsor_id: SPONSOR_ID,
            ref,
            sig: "A".repeat(32),
          }),
        }),
        env,
      );
      expect(forgedUnsub.status).toBe(403);

      const unconfiguredUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sponsor_id: SPONSOR_ID, ref, sig }),
        }),
        { ...env, EMAIL_ACTION_LINK_SECRET: undefined } as unknown as Env,
      );
      expect(unconfiguredUnsub.status).toBe(503);

      const okUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sponsor_id: SPONSOR_ID, ref, sig }),
        }),
        env,
      );
      expect(okUnsub.status).toBe(200);
      expect(okUnsub.headers.get("cache-control")).toBe("private, no-store");
      const digState = sqlite
        .prepare(
          "SELECT state FROM transactional_email_outbox WHERE idempotency_key = 'email:mount:dig:1'",
        )
        .get() as { state: string };
      const secState = sqlite
        .prepare(
          "SELECT state FROM transactional_email_outbox WHERE idempotency_key = 'email:mount:sec:1'",
        )
        .get() as { state: string };
      expect(digState.state).toBe("suppressed_unsubscribed");
      expect(secState.state).toBe("pending");

      // 4. Operator outbox health: regular sponsor refused 401 UNAUTHORIZED (Rule A5 anti-oracle), operator gets aggregate counts only!
      const sponsorHealth = await signedRequest({
        method: "GET",
        path: "/v1/operators/email-outbox/health",
        action: "operator.email-outbox.read",
        principalType: "sponsor",
        principalId: SPONSOR_ID,
      });
      expect(sponsorHealth.status).toBe(401);
      expect(((await sponsorHealth.json()) as { code: string }).code).toBe("UNAUTHORIZED");

      const opHealth = await signedRequest({
        method: "GET",
        path: "/v1/operators/email-outbox/health",
        action: "operator.email-outbox.read",
        principalType: "operator",
        principalId: OPERATOR,
      });
      expect(opHealth.status).toBe(200);
      const opHealthText = await opHealth.text();
      expect(opHealthText).not.toContain(RECIPIENT);
      expect(JSON.parse(opHealthText)).toEqual({
        pending: 2,
        delivered: 0,
        dead_letter: 0,
        suppressed_unsubscribed: 1,
        deferred_spend_cap: 0,
        degraded: false,
      });

      // 5. Scheduled reconcile is an explicit no-op when RESEND_API_KEY is unset.
      const disabledReconcile = await reconcileTransactionalEmailOutbox(env);
      expect(disabledReconcile.enabled).toBe(false);
      expect(disabledReconcile.delivered).toBe(0);

      // 6. Sponsor account deletion atomically purges ONLY SPONSOR_ID's email_preferences & outbox rows!
      const nowEpochMs = Date.now();
      sqlite
        .prepare(
          `INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)
           ON CONFLICT(sponsor_id) DO NOTHING`,
        )
        .run(SPONSOR_ID, nowEpochMs - 60_000, nowEpochMs - 1_000);
      await db.batch(sponsorAccountDeletionStatements(db, SPONSOR_ID, nowEpochMs));
      const remainingPref = sqlite
        .prepare("SELECT COUNT(*) AS c FROM email_preferences WHERE sponsor_id = ?")
        .get(SPONSOR_ID) as { c: number };
      const remainingOutbox = sqlite
        .prepare("SELECT COUNT(*) AS c FROM transactional_email_outbox WHERE sponsor_id = ?")
        .get(SPONSOR_ID) as { c: number };
      const otherPref = sqlite
        .prepare("SELECT COUNT(*) AS c FROM email_preferences WHERE sponsor_id = ?")
        .get(OTHER_SPONSOR) as { c: number };
      const otherOutbox = sqlite
        .prepare("SELECT COUNT(*) AS c FROM transactional_email_outbox WHERE sponsor_id = ?")
        .get(OTHER_SPONSOR) as { c: number };
      expect(remainingPref.c).toBe(0);
      expect(remainingOutbox.c).toBe(0);
      expect(otherPref.c).toBe(1);
      expect(otherOutbox.c).toBe(1);

      // 7. Wave 9 GDPR resurrection guard: replaying the old signed unsubscribe link for the
      //    now-tombstoned SPONSOR_ID returns 200 cleanly WITHOUT resurrecting an email_preferences row!
      const replayUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sponsor_id: SPONSOR_ID, ref, sig }),
        }),
        env,
      );
      expect(replayUnsub.status).toBe(200);
      const resurrectedPref = sqlite
        .prepare("SELECT COUNT(*) AS c FROM email_preferences WHERE sponsor_id = ?")
        .get(SPONSOR_ID) as { c: number };
      expect(resurrectedPref.c).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("Wave 9 resilience & causal producers: transient lookup error backs off without aborting batch; live Stoa panic & enrollment claim enqueue clean outbox rows", async () => {
    const { db, sqlite } = migratedSqliteD1();
    try {
      // A. Transient resolveRecipientEmail failure retries row 1 without crashing row 2!
      const nowMs = Date.parse("2026-11-23T04:00:00.000Z");
      const nowIso = new Date(nowMs).toISOString();
      const sponsorBad = "usr_ops7_transient_1";
      const sponsorGood = "usr_ops7_transient_2";
      for (const [idx, sp] of [
        [1, sponsorBad],
        [2, sponsorGood],
      ] as const) {
        const rendered = await renderTransactionalEmail({
          emailClass: "security_alert",
          sponsorId: sp,
          agoraOrigin: AGORA,
          actionPath: "/console",
          linkSecret: LINK_SECRET,
          summaryLabel: `Alert ${idx}`,
          referenceId: `TR-${idx}`,
          occurredAtIso: nowIso,
        });
        await (
          await prepareEnqueueTransactionalEmail(db, {
            idempotencyKey: `email:tr:${idx}`,
            causalEventId: null,
            sponsorId: sp,
            recipientEmail: `sp${idx}@example.org`,
            rendered,
            agoraOrigin: AGORA,
            nowIso,
          })
        ).run();
      }
      const drainRes = await drainTransactionalEmailOutbox(db, {
        transport: { send: async () => ({ ok: true, providerMessageId: "re_tr_ok" }) },
        fromAddress: "ASImposium <notices@asimposium.org>",
        agoraOrigin: AGORA,
        nowMs,
        resolveRecipientEmail: async (sp) => {
          if (sp === sponsorBad) throw new Error("TRANSIENT_D1_GLITCH");
          return "sp2@example.org";
        },
      });
      expect(drainRes.retried).toBe(1);
      expect(drainRes.delivered).toBe(1);
      const badRow = sqlite
        .prepare(
          "SELECT state, attempts, last_error_code FROM transactional_email_outbox WHERE idempotency_key = 'email:tr:1'",
        )
        .get() as { state: string; attempts: number; last_error_code: string };
      expect(badRow).toEqual({
        state: "pending",
        attempts: 1,
        last_error_code: "RECIPIENT_LOOKUP_ERROR",
      });

      // B. Mounted Stoa causal producers: POST /v1/fellows (enrollment_approval) and POST /v1/sponsors/panic (security_alert)
      const SPONSOR_LIVE = "usr_ops7_causal_1";
      const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair;
      const pubHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
      const replayKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );
      const env = {
        DB: db,
        STOA_ORIGIN: "https://a.asimposium.org",
        AGORA_ORIGIN: AGORA,
        SERVICE_ENVELOPE_KEYS: JSON.stringify([
          { kid: "k-causal", publicKeyHex: pubHex, notBefore: 0 },
        ]),
        ENROLLMENT_REPLAY_KEY: replayKey,
        EMAIL_ACTION_LINK_SECRET: LINK_SECRET,
      } as unknown as Env;
      const app = createApp();

      const signed = async (
        path: string,
        action: string,
        body: string,
        idempotencyKey?: string,
      ) => {
        const envelope = await mintServiceEnvelope({
          kid: "k-causal",
          privateKey: keyPair.privateKey,
          issuer: "agora",
          audience: "stoa",
          principalType: "sponsor",
          principalId: SPONSOR_LIVE,
          method: "POST",
          route: path,
          action,
          body,
          now: Math.floor(Date.now() / 1_000),
        });
        return app.fetch(
          new Request(`https://a.asimposium.org${path}`, {
            method: "POST",
            headers: {
              ...serviceEnvelopeHeaders(envelope),
              "content-type": "application/json",
              ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
            },
            body,
          }),
          env,
        );
      };

      // Bootstrap sponsor & configure private notification email via mounted routes.
      const bootRes = await signed("/v1/sponsors/bootstrap", "sponsor.bootstrap", "{}");
      expect([200, 201]).toContain(bootRes.status);
      const prefRes = await signed(
        "/v1/sponsors/email-preferences",
        "email-preferences.write",
        JSON.stringify({ digest_opt_in: false, notification_email: "causal@example.org" }),
      );
      expect(prefRes.status).toBe(200);

      // Mint join URL & claim proposal as agent -> enqueues enrollment_approval with ZERO secret leakage!
      const mintRes = await signed(
        "/v1/enrollments",
        "enrollment.mint",
        JSON.stringify({ requested_scopes: ["promote"] }),
        "causal-mint-1",
      );
      expect(mintRes.status).toBe(201);
      const minted = (await mintRes.json()) as { enrollment_id: string; secret: string };

      const claimRes = await app.fetch(
        new Request("https://a.asimposium.org/v1/fellows", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "causal-claim-1",
          },
          body: JSON.stringify({
            enrollment_id: minted.enrollment_id,
            secret: minted.secret,
            name: "causal-euler-fellow",
            model: "test-lab/model-1",
            harness: "codex",
          }),
        }),
        env,
      );
      expect(claimRes.status).toBe(202);
      const claimed = (await claimRes.json()) as { flow_handle: string };

      const enrollEmail = sqlite
        .prepare(
          `SELECT email_class, subject, text_body, html_body, action_url
           FROM transactional_email_outbox
           WHERE sponsor_id = ? AND email_class = 'enrollment_approval'`,
        )
        .get(SPONSOR_LIVE) as {
        email_class: string;
        subject: string;
        text_body: string;
        html_body: string;
        action_url: string;
      } | null;
      expect(enrollEmail).not.toBeNull();
      const enrollCombined = JSON.stringify(enrollEmail);
      expect(enrollCombined).not.toContain(minted.secret);
      expect(enrollCombined).not.toContain(claimed.flow_handle);
      expect(enrollCombined).not.toContain("causal@example.org");
      expect(enrollEmail?.action_url).toStartWith(`${AGORA}/console?`);

      // Trigger sponsor panic -> enqueues security_alert!
      const panicRes = await signed(
        "/v1/sponsors/panic",
        "sponsor.panic",
        JSON.stringify({
          confirm: "revoke-all-fellow-credentials",
          step_up_authenticated_at: Math.floor(Date.now() / 1_000),
        }),
        "causal-panic-1",
      );
      expect(panicRes.status).toBe(200);
      const panicEmail = sqlite
        .prepare(
          `SELECT email_class, subject, action_url
           FROM transactional_email_outbox
           WHERE sponsor_id = ? AND email_class = 'security_alert'`,
        )
        .get(SPONSOR_LIVE) as { email_class: string; subject: string; action_url: string } | null;
      expect(panicEmail).not.toBeNull();
      expect(panicEmail?.action_url).toStartWith(`${AGORA}/console?`);

      // Wave 11 hardening: query-string smuggling and non-JSON content-type fail closed
      const badQueryUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe?sig=leaked", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sponsor_id: SPONSOR_LIVE,
            ref: `unsub-${SPONSOR_LIVE}`,
            sig: "0123456789abcdef0123456789abcdef",
          }),
        }),
        env,
      );
      expect(badQueryUnsub.status).toBe(422);

      const nonJsonUnsub = await app.fetch(
        new Request("https://a.asimposium.org/v1/email/unsubscribe", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({
            sponsor_id: SPONSOR_LIVE,
            ref: `unsub-${SPONSOR_LIVE}`,
            sig: "0123456789abcdef0123456789abcdef",
          }),
        }),
        env,
      );
      expect(nonJsonUnsub.status).toBe(415);

      // Wave 11 hardening: a throwing email transport backs off cleanly (`TRANSPORT_THROW`)
      // instead of aborting the scheduled drain batch.
      const throwDrain = await drainTransactionalEmailOutbox(db, {
        transport: {
          send: async () => {
            throw new Error("simulated unexpected socket reset");
          },
        },
        fromAddress: "ASImposium <noreply@asimposium.org>",
        agoraOrigin: AGORA,
        nowMs: Date.now() + 5_000,
        resolveRecipientEmail: async () => "causal@example.org",
      });
      expect(throwDrain.delivered).toBe(0);
      expect(throwDrain.retried).toBeGreaterThanOrEqual(1);
      const errRow = sqlite
        .prepare(
          `SELECT last_error_code, attempts FROM transactional_email_outbox WHERE sponsor_id = ? LIMIT 1`,
        )
        .get(SPONSOR_LIVE) as { last_error_code: string | null; attempts: number } | null;
      expect(errRow?.last_error_code).toBe("TRANSPORT_THROW");
      expect(errRow?.attempts).toBe(1);

      // Wave 17 hardening:
      // 1) EMAIL_MONTHLY_CAP="0" emergency-pauses outbound email (does NOT fail open to 3000!).
      sqlite.run(
        "UPDATE transactional_email_outbox SET next_retry_at = '2020-01-01T00:00:00.000Z' WHERE sponsor_id = ?",
        [SPONSOR_LIVE],
      );
      const paused = await reconcileTransactionalEmailOutbox({
        DB: db,
        RESEND_API_KEY: "re_test_paused",
        EMAIL_FROM_ADDRESS: "ASImposium <noreply@asimposium.org>",
        AGORA_ORIGIN: AGORA,
        EMAIL_MONTHLY_CAP: "0",
      });
      expect(paused.enabled).toBe(true);
      expect(paused.delivered).toBe(0);
      expect(paused.deferred_spend_cap).toBeGreaterThanOrEqual(1);

      // 2) Malformed 200 OK JSON from Resend maps cleanly to PROVIDER_MISSING_MESSAGE_ID.
      const badJsonTransport = createResendFetchTransport({
        apiKey: "re_test_bad_json",
        fetchImpl: (async () =>
          new Response("not-json", { status: 200 })) as unknown as typeof fetch,
      });
      const badJsonRes = await badJsonTransport.send({
        idempotencyKey: "k-bad-json",
        from: "ASImposium <noreply@asimposium.org>",
        to: "causal@example.org",
        subject: "Test",
        text: "Test",
        html: "<p>Test</p>",
      });
      expect(badJsonRes).toEqual({
        ok: false,
        retryable: true,
        errorCode: "PROVIDER_MISSING_MESSAGE_ID",
      });

      // 3) Concurrent tombstone race inside setSponsorDigestPreference never resurrects PII.
      const raceSponsor = "usr_ops7_tombstone_race";
      sqlite.run("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)", [
        raceSponsor,
        Date.now(),
        Date.now(),
      ]);
      let injectedTombstone = false;
      const racingDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (!injectedTombstone && sql.includes("INSERT INTO email_preferences")) {
                injectedTombstone = true;
                sqlite.run("UPDATE sponsors SET tombstoned_at = ? WHERE sponsor_id = ?", [
                  Date.now(),
                  raceSponsor,
                ]);
              }
              return target.prepare(sql);
            };
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        },
      });
      const raceRes = await setSponsorDigestPreference(racingDb, {
        sponsorId: raceSponsor,
        optIn: true,
        notificationEmail: "raced.pii@example.org",
        nowIso: new Date().toISOString(),
      });
      expect(injectedTombstone).toBe(true);
      expect(raceRes).toEqual({ updated: false, tombstoned: true });
      const resurrected = sqlite
        .prepare("SELECT notification_email FROM email_preferences WHERE sponsor_id = ?")
        .get(raceSponsor);
      expect(resurrected).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
