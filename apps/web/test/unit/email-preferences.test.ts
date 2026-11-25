import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnsubscribeDigestView } from "../../components/unsubscribe-digest-view";
import { parseNotificationEmailInput, parseUnsubscribeQuery } from "../../lib/email-preferences";
import { stoaPublicEmailUnsubscribe } from "../../lib/email-unsubscribe-client";
import nextConfig from "../../next.config";

describe("OPS.7 Agora email preferences & signed unsubscribe helpers", () => {
  test("parseUnsubscribeQuery accepts canonical signed parameters and rejects malformed or tampered inputs", () => {
    const validSig = "0123456789abcdef0123456789abcdef";
    const parsed = parseUnsubscribeQuery({
      ref: "unsub-usr_sponsor_ops7_1",
      sig: validSig,
    });
    expect(parsed).toEqual({
      sponsorId: "usr_sponsor_ops7_1",
      ref: "unsub-usr_sponsor_ops7_1",
      sig: validSig,
    });

    // Missing / wrong prefix / non-canonical sponsor / bad sig / duplicate query arrays all fail closed.
    expect(parseUnsubscribeQuery({ ref: "usr_sponsor_ops7_1", sig: validSig })).toBeUndefined();
    expect(parseUnsubscribeQuery({ ref: "unsub-not-a-sponsor", sig: validSig })).toBeUndefined();
    expect(
      parseUnsubscribeQuery({ ref: "unsub-usr_sponsor_ops7_1", sig: "short" }),
    ).toBeUndefined();
    expect(
      parseUnsubscribeQuery({
        ref: ["unsub-usr_sponsor_ops7_1", "unsub-usr_sponsor_ops7_2"],
        sig: validSig,
      }),
    ).toBeUndefined();
    expect(
      parseUnsubscribeQuery({
        ref: "unsub-usr_sponsor_ops7_1",
        sig: validSig,
        extra: "1",
      }),
    ).toBeUndefined();
    expect(
      parseUnsubscribeQuery({
        ref: "unsub-usr_sponsor_ops7_1",
        sig: validSig,
        status: "",
      }),
    ).toBeUndefined();
    expect(parseUnsubscribeQuery({})).toBeUndefined();
  });

  test("parseNotificationEmailInput handles unchanged, clear, normalized valid email, and rejects CRLF/invalid input", () => {
    expect(parseNotificationEmailInput({ rawEmail: "   ", clearRequested: false })).toEqual({
      ok: true,
      mode: "unchanged",
    });
    expect(
      parseNotificationEmailInput({ rawEmail: "ignored@example.org", clearRequested: true }),
    ).toEqual({
      ok: true,
      mode: "clear",
      email: null,
    });
    expect(
      parseNotificationEmailInput({
        rawEmail: "  Sponsor+Ops7@Example.ORG ",
        clearRequested: false,
      }),
    ).toEqual({
      ok: true,
      mode: "set",
      email: "sponsor+ops7@example.org",
    });
    expect(
      parseNotificationEmailInput({
        rawEmail: "bad@example.org\r\nBcc: evil@example.org",
        clearRequested: false,
      }),
    ).toEqual({ ok: false });
    expect(
      parseNotificationEmailInput({ rawEmail: "not-an-email", clearRequested: false }),
    ).toEqual({ ok: false });
  });

  test("UnsubscribeDigestView renders read-only confirmation on GET and stoaPublicEmailUnsubscribe POSTs cleanly to trusted loopback Stoa", async () => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({ method: req.method, url: req.url, body });
        const parsed = JSON.parse(body) as { sponsor_id: string; sig: string };
        if (parsed.sig === "0123456789abcdef0123456789abcdef") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              unsubscribed: true,
              sponsor_id: parsed.sponsor_id,
              digest_opt_in: false,
              updated_at: "2026-11-23T06:00:00.000Z",
            }),
          );
          return;
        }
        if (parsed.sig === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") {
          // Oversized chunked response (>16 KiB, no content-length) exercises the streaming cap.
          res.writeHead(200, { "content-type": "application/json" });
          res.write(`{"pad":"${"x".repeat(12_000)}`);
          res.end(`${"y".repeat(8_000)}"}`);
          return;
        }
        res.writeHead(403, { "content-type": "application/problem+json" });
        res.end(JSON.stringify({ code: "UNAUTHORIZED" }));
      });
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      const validSig = "0123456789abcdef0123456789abcdef";
      const token = parseUnsubscribeQuery({
        ref: "unsub-usr_sponsor_ops7_1",
        sig: validSig,
      });
      const noopAction = async () => {};

      // 1. Rendering the GET view performs ZERO outbound HTTP mutations!
      const html = renderToStaticMarkup(
        createElement(UnsubscribeDigestView, {
          status: undefined,
          token,
          confirmAction: noopAction,
        }),
      );
      expect(received).toHaveLength(0);
      expect(html).toContain("Confirm digest unsubscribe");
      expect(html).toContain("Turn off digest emails");
      expect(html).toContain(`value="unsub-usr_sponsor_ops7_1"`);
      expect(html).toContain(`value="${validSig}"`);

      expect(
        renderToStaticMarkup(
          createElement(UnsubscribeDigestView, {
            status: "done",
            token: undefined,
            confirmAction: noopAction,
          }),
        ),
      ).toContain("Digest turned off");

      expect(
        renderToStaticMarkup(
          createElement(UnsubscribeDigestView, {
            status: undefined,
            token: undefined,
            confirmAction: noopAction,
          }),
        ),
      ).toContain("Incomplete unsubscribe link");

      // 2. Explicit POST client rejects untrusted Stoa origins before sending a byte.
      const untrusted = await stoaPublicEmailUnsubscribe(
        {
          sponsor_id: "usr_sponsor_ops7_1",
          ref: "unsub-usr_sponsor_ops7_1",
          sig: validSig,
        },
        "https://evil.example.invalid",
      );
      expect(untrusted).toEqual({ ok: false, reason: "unconfigured" });
      expect(received).toHaveLength(0);

      // 3. Valid POST succeeds cleanly; tampered signature fails closed with refused 403.
      const ok = await stoaPublicEmailUnsubscribe(
        {
          sponsor_id: "usr_sponsor_ops7_1",
          ref: "unsub-usr_sponsor_ops7_1",
          sig: validSig,
        },
        origin,
      );
      expect(ok.ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]?.method).toBe("POST");
      expect(received[0]?.url).toBe("/v1/email/unsubscribe");

      const bad = await stoaPublicEmailUnsubscribe(
        {
          sponsor_id: "usr_sponsor_ops7_1",
          ref: "unsub-usr_sponsor_ops7_1",
          sig: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        origin,
      );
      expect(bad).toEqual({ ok: false, reason: "refused", status: 403 });

      const oversized = await stoaPublicEmailUnsubscribe(
        {
          sponsor_id: "usr_sponsor_ops7_1",
          ref: "unsub-usr_sponsor_ops7_1",
          sig: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        origin,
      );
      expect(oversized).toEqual({ ok: false, reason: "unreachable" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("next.config places /console/email-preferences/unsubscribe no-referrer + private no-store override AFTER /(.*)", async () => {
    const headerRules = (await nextConfig.headers?.()) ?? [];
    const globalIdx = headerRules.findIndex((r) => r.source === "/(.*)");
    const unsubIdx = headerRules.findIndex(
      (r) => r.source === "/console/email-preferences/unsubscribe",
    );
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(unsubIdx).toBeGreaterThan(globalIdx);
    const unsubHeaders = headerRules[unsubIdx]?.headers ?? [];
    expect(unsubHeaders).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    expect(unsubHeaders).toContainEqual({ key: "Cache-Control", value: "private, no-store" });
  });
});
