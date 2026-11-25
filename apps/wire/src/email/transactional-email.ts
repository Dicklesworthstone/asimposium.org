/**
 * OPS.7 Minimal Transactional Email via D1 Outbox (bead asimposiumorg-d5x).
 *
 * Strict product & privacy boundary:
 *   - Exactly four classes are permitted:
 *       1. `enrollment_approval`  — pending Fellow enrollment notice for an away sponsor
 *       2. `security_alert`       — credential/panic/suspension alert (transactional)
 *       3. `moderation_notice`    — quarantine/takedown/appeal notice (transactional)
 *       4. `opt_in_digest`        — explicit opt-in summary (honors immediate unsubscribe)
 *   - No per-event mail, no follower alerts, no engagement campaigns, no model-generated copy.
 *   - Enqueued transactionally in the same D1 batch as the causal write (`enqueueTransactionalEmailStatements`).
 *   - At-least-once delivery with `Idempotency-Key`, bounded exponential retry/backoff,
 *     visible `dead_letter` state, `provider_message_id` receipt, monthly spend cap,
 *     and operator alert on sustained failure or cap breach.
 *   - Hard egress safety wall: EVERY subject, text body, HTML body, and action URL is
 *     scanned against P7 credential shapes, fragment secrets (`#v1.`), Fellow tokens,
 *     flow handles, policy-detector names, and trusted host-only `AGORA_ORIGIN` before
 *     enqueueing AND before transport dispatch.
 *   - Provider outage NEVER blocks ledger writes or enrollment proposals; Agora `/console`
 *     remains canonical and `readEmailOutboxHealth(db)` surfaces delayed/dead-letter counts.
 */

import { isTrustedAgoraOrigin } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { constantTimeEqual } from "../auth/canonical.ts";
import type { Env } from "../env.ts";
import { bodyLooksSecretShaped } from "../krater/cas.ts";
import { sha256Hex } from "../krater/krater.ts";
import { scanTextForCredentials } from "../screening/credential-scan.ts";

export const TRANSACTIONAL_EMAIL_PROVIDER = "resend" as const;
export const RESEND_API_ENDPOINT = "https://api.resend.com/emails" as const;
export const DEFAULT_EMAIL_MONTHLY_CAP = 3_000;
export const DEFAULT_EMAIL_WARN_THRESHOLD = 2_400;
export const DEFAULT_EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_BASE_BACKOFF_MS = 30_000;
export const EMAIL_MAX_BACKOFF_MS = 30 * 60_000;
export const SUSTAINED_FAILURE_ALERT_THRESHOLD = 3;

export const ALLOWED_EMAIL_CLASSES = [
  "enrollment_approval",
  "security_alert",
  "moderation_notice",
  "opt_in_digest",
] as const;

export type TransactionalEmailClass = (typeof ALLOWED_EMAIL_CLASSES)[number];

const ALLOWED_EMAIL_CLASS_SET: ReadonlySet<string> = new Set(ALLOWED_EMAIL_CLASSES);

/**
 * Coarse forbidden egress markers that must NEVER leave in any email template:
 * enrollment fragments, Fellow tokens, flow handles, auth codes, policy detector
 * internals, or raw workshop/directive markers.
 */
const FORBIDDEN_EMAIL_EGRESS_PATTERNS: readonly RegExp[] = [
  /#v1\.[A-Za-z0-9_-]{8,}/i,
  /\basimp_ag_[A-Za-z0-9_-]+/i,
  /\bflow_v1\.[A-Za-z0-9_-]+/i,
  /\bauthorization\s*:\s*bearer\b/i,
  /\basimp-service-envelope\b/i,
  /\b(?:acip_rule_|detector_pattern_|regex_match_|internal_score_|chain_of_thought)/i,
  /\b(?:WORKSHOP_PRIVATE_|RAW_WORKSHOP_BODY|HIDDEN_REASONING)/,
];

export class TransactionalEmailPolicyError extends Error {
  readonly code:
    | "EMAIL_CLASS_FORBIDDEN"
    | "EMAIL_EGRESS_SECRET_REFUSED"
    | "EMAIL_ACTION_URL_UNTRUSTED"
    | "EMAIL_RECIPIENT_INVALID"
    | "EMAIL_TEMPLATE_INCOMPLETE";

  constructor(code: TransactionalEmailPolicyError["code"], message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface EmailTemplateInput {
  readonly emailClass: TransactionalEmailClass;
  readonly sponsorId: string;
  readonly agoraOrigin: string;
  readonly actionPath: string;
  readonly linkSecret: string;
  readonly summaryLabel: string;
  readonly referenceId: string;
  readonly occurredAtIso: string;
  /** Optional unsubscribe path on Agora (required for `opt_in_digest`). */
  readonly unsubscribePath?: string;
}

export interface RenderedTransactionalEmail {
  readonly emailClass: TransactionalEmailClass;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly actionUrl: string;
  readonly listUnsubscribeUrl?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const MIN_LINK_SECRET_LENGTH = 16;
const DELIVERY_LEASE_MS = 5 * 60_000;

function isValidEmailAddress(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 254 &&
    !/[\r\n\0]/.test(value) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function isSafeHeaderValue(value: string): boolean {
  return value.trim().length > 0 && value.length <= 254 && !/[\r\n\0]/.test(value);
}

async function signAgoraActionToken(opts: {
  readonly sponsorId: string;
  readonly actionPath: string;
  readonly referenceId: string;
  readonly linkSecret: string;
}): Promise<string> {
  if (opts.linkSecret.length < MIN_LINK_SECRET_LENGTH) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_TEMPLATE_INCOMPLETE",
      `linkSecret must be at least ${MIN_LINK_SECRET_LENGTH} characters.`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(opts.linkSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${opts.sponsorId}|${opts.actionPath}|${opts.referenceId}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return toBase64Url(sig).slice(0, 32);
}

/** Mint a short HMAC-SHA256 signed host-only Agora deep link (never carries secrets or fragments). */
export async function mintSignedAgoraActionUrl(opts: {
  readonly agoraOrigin: string;
  readonly actionPath: string;
  readonly sponsorId: string;
  readonly referenceId: string;
  readonly linkSecret: string;
}): Promise<string> {
  if (!isTrustedAgoraOrigin(opts.agoraOrigin)) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_ACTION_URL_UNTRUSTED",
      "Email action links must target a trusted host-only Agora origin.",
    );
  }
  if (
    !opts.actionPath.startsWith("/") ||
    opts.actionPath.startsWith("//") ||
    opts.actionPath.includes("#") ||
    opts.actionPath.includes("?") ||
    opts.actionPath.includes("\\") ||
    opts.actionPath.includes("..") ||
    /[\r\n\t\0]/.test(opts.actionPath)
  ) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_ACTION_URL_UNTRUSTED",
      "Email action path must be a normalized, query/fragment-free relative Agora path.",
    );
  }

  const token = await signAgoraActionToken(opts);
  const url = new URL(opts.actionPath, opts.agoraOrigin);
  url.hash = "";
  url.searchParams.set("ref", opts.referenceId);
  url.searchParams.set("sig", token);
  return url.toString();
}

/** Constant-time verification of a signed host-only Agora action or unsubscribe link token. */
export async function verifySignedAgoraActionToken(opts: {
  readonly sponsorId: string;
  readonly actionPath: string;
  readonly referenceId: string;
  readonly sig: string;
  readonly linkSecret: string;
}): Promise<boolean> {
  if (
    opts.linkSecret.length < MIN_LINK_SECRET_LENGTH ||
    !/^[A-Za-z0-9_-]{32}$/.test(opts.sig) ||
    !opts.actionPath.startsWith("/") ||
    opts.actionPath.includes("..")
  ) {
    return false;
  }
  const expected = await signAgoraActionToken(opts);
  return constantTimeEqual(expected, opts.sig);
}

/**
 * Hard egress wall: refuses any credential shape, fragment secret, policy-detector
 * internal, or untrusted URL before the row enters D1 or leaves for the provider.
 */
export function assertEmailContentSafe(fields: {
  readonly emailClass: string;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly actionUrl: string;
  readonly listUnsubscribeUrl?: string | null;
  readonly agoraOrigin: string;
}): void {
  if (!ALLOWED_EMAIL_CLASS_SET.has(fields.emailClass)) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_CLASS_FORBIDDEN",
      `Unsupported transactional email class: ${fields.emailClass}`,
    );
  }

  const urlsToVerify: Array<readonly [string, string]> = [["action_url", fields.actionUrl]];
  if (fields.listUnsubscribeUrl) {
    urlsToVerify.push(["list_unsubscribe_url", fields.listUnsubscribeUrl]);
  }
  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(fields.agoraOrigin).origin;
  } catch {
    throw new TransactionalEmailPolicyError(
      "EMAIL_ACTION_URL_UNTRUSTED",
      "Configured Agora origin is not a valid URL.",
    );
  }
  for (const [label, rawUrl] of urlsToVerify) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new TransactionalEmailPolicyError(
        "EMAIL_ACTION_URL_UNTRUSTED",
        `Email URL '${label}' is not a valid URL.`,
      );
    }
    if (
      parsedUrl.origin !== trustedOrigin ||
      !isTrustedAgoraOrigin(parsedUrl.origin) ||
      parsedUrl.hash !== ""
    ) {
      throw new TransactionalEmailPolicyError(
        "EMAIL_ACTION_URL_UNTRUSTED",
        `Email URL '${label}' must stay on the host-only Agora origin with no URL fragment.`,
      );
    }
  }

  for (const [label, text] of [
    ["subject", fields.subject],
    ["text_body", fields.textBody],
    ["html_body", fields.htmlBody],
    ...urlsToVerify,
  ] as const) {
    if (text.trim().length === 0) {
      throw new TransactionalEmailPolicyError(
        "EMAIL_TEMPLATE_INCOMPLETE",
        `Email field '${label}' cannot be empty.`,
      );
    }
    if (scanTextForCredentials(label, text).length > 0 || bodyLooksSecretShaped(text)) {
      throw new TransactionalEmailPolicyError(
        "EMAIL_EGRESS_SECRET_REFUSED",
        `Credential- or personal-address-shaped bytes detected in email '${label}'.`,
      );
    }
    for (const pattern of FORBIDDEN_EMAIL_EGRESS_PATTERNS) {
      if (pattern.test(text)) {
        throw new TransactionalEmailPolicyError(
          "EMAIL_EGRESS_SECRET_REFUSED",
          `Forbidden secret/private/detector pattern detected in email '${label}'.`,
        );
      }
    }
  }
}

/**
 * Render an accessible HTML + plain-text transactional email for one of the four
 * allowed classes. Templates carry minimum metadata needed to act and a signed link
 * back to the host-only Agora — NEVER raw scientific bodies, workshop drafts,
 * enrollment fragments, bearer tokens, or detector details.
 */
export async function renderTransactionalEmail(
  input: EmailTemplateInput,
): Promise<RenderedTransactionalEmail> {
  if (!ALLOWED_EMAIL_CLASS_SET.has(input.emailClass)) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_CLASS_FORBIDDEN",
      `Unsupported transactional email class: ${input.emailClass}`,
    );
  }
  if (input.summaryLabel.length === 0 || input.summaryLabel.length > 160) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_TEMPLATE_INCOMPLETE",
      "summaryLabel must be 1..160 characters of minimal non-sensitive metadata.",
    );
  }

  const actionUrl = await mintSignedAgoraActionUrl({
    agoraOrigin: input.agoraOrigin,
    actionPath: input.actionPath,
    sponsorId: input.sponsorId,
    referenceId: input.referenceId,
    linkSecret: input.linkSecret,
  });

  let listUnsubscribeUrl: string | undefined;
  if (input.emailClass === "opt_in_digest") {
    const unsubPath = input.unsubscribePath ?? "/console/email-preferences/unsubscribe";
    listUnsubscribeUrl = await mintSignedAgoraActionUrl({
      agoraOrigin: input.agoraOrigin,
      actionPath: unsubPath,
      sponsorId: input.sponsorId,
      referenceId: `unsub-${input.sponsorId}`,
      linkSecret: input.linkSecret,
    });
  }

  const copyByClass: Record<
    TransactionalEmailClass,
    {
      readonly subject: string;
      readonly heading: string;
      readonly lead: string;
      readonly ctaLabel: string;
      readonly footer: string;
    }
  > = {
    enrollment_approval: {
      subject: `[ASImposium] Pending Fellow approval (${input.referenceId})`,
      heading: "Pending Fellow Enrollment Approval",
      lead: `A Fellow proposal (${input.summaryLabel}) is waiting for your explicit approval in your ASImposium Sponsor Console.`,
      ctaLabel: "Review pending enrollment in Console",
      footer:
        "This transactional notice carries no enrollment secret or token. Sign in with Google on asimposium.org to approve or deny.",
    },
    security_alert: {
      subject: `[ASImposium] Security alert (${input.referenceId})`,
      heading: "Sponsor Account Security Alert",
      lead: `A security event was recorded on your sponsor account (${input.summaryLabel}) at ${input.occurredAtIso}.`,
      ctaLabel: "Inspect security state in Console",
      footer:
        "This is a required transactional security notice and cannot be unsubscribed. Your Console on asimposium.org is canonical.",
    },
    moderation_notice: {
      subject: `[ASImposium] Moderation or appeal update (${input.referenceId})`,
      heading: "Moderation & Appeal Notice",
      lead: `A moderation or appeal status update (${input.summaryLabel}) was recorded at ${input.occurredAtIso}.`,
      ctaLabel: "View notice and appeal options in Console",
      footer:
        "This is a required transactional moderation notice. Coarse status only; review full record in your authenticated Console.",
    },
    opt_in_digest: {
      subject: `[ASImposium] Your opt-in ledger digest (${input.referenceId})`,
      heading: "ASImposium Opt-In Digest",
      lead: `Summary metadata (${input.summaryLabel}) captured at ${input.occurredAtIso}. Open Agora to read canonical public faces.`,
      ctaLabel: "Open Agora Console",
      footer:
        "You are receiving this digest because you explicitly opted in. Unsubscribe immediately using the link below.",
    },
  };

  const copy = copyByClass[input.emailClass];
  const textLines = [
    copy.heading,
    "=".repeat(copy.heading.length),
    "",
    copy.lead,
    "",
    `Reference: ${input.referenceId}`,
    `Timestamp: ${input.occurredAtIso}`,
    `${copy.ctaLabel}: ${actionUrl}`,
    "",
    copy.footer,
  ];
  if (listUnsubscribeUrl) {
    textLines.push(`Unsubscribe immediately: ${listUnsubscribeUrl}`);
  }
  const textBody = `${textLines.join("\n")}\n`;

  const unsubHtml = listUnsubscribeUrl
    ? `<p style="margin-top:16px;font-size:13px;color:#334155;"><a href="${escapeHtml(listUnsubscribeUrl)}" style="color:#0f172a;text-decoration:underline;">Unsubscribe immediately from digests</a></p>`
    : "";

  const htmlBody = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(copy.subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#ffffff;color:#0f172a;font-family:system-ui,-apple-system,sans-serif;line-height:1.5;">',
    '<main role="main" style="max-width:600px;margin:0 auto;">',
    `<h1 style="font-size:20px;margin:0 0 12px 0;">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0 0 12px 0;">${escapeHtml(copy.lead)}</p>`,
    `<p style="margin:0 0 16px 0;font-size:14px;color:#334155;">Reference: <code>${escapeHtml(input.referenceId)}</code> &middot; ${escapeHtml(input.occurredAtIso)}</p>`,
    `<p style="margin:0 0 16px 0;"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(copy.ctaLabel)}</a></p>`,
    `<p style="margin:0 0 12px 0;font-size:13px;color:#334155;">Direct link: <a href="${escapeHtml(actionUrl)}" style="color:#0f172a;">${escapeHtml(actionUrl)}</a></p>`,
    `<footer style="margin-top:20px;padding-top:12px;border-top:1px solid #cbd5e1;font-size:13px;color:#334155;"><p style="margin:0;">${escapeHtml(copy.footer)}</p>${unsubHtml}</footer>`,
    "</main></body></html>",
  ].join("");

  assertEmailContentSafe({
    emailClass: input.emailClass,
    subject: copy.subject,
    textBody,
    htmlBody,
    actionUrl,
    listUnsubscribeUrl,
    agoraOrigin: input.agoraOrigin,
  });

  return {
    emailClass: input.emailClass,
    subject: copy.subject,
    textBody,
    htmlBody,
    actionUrl,
    listUnsubscribeUrl,
  };
}

/**
 * Prepare D1 statements to enqueue a transactional email inside the SAME atomic
 * D1 transaction (`db.batch([...causalStatements, ...emailStatements])`) as the
 * causal event. Uses `INSERT OR IGNORE` on `idempotency_key` so retries never
 * double-enqueue.
 */
export async function prepareEnqueueTransactionalEmail(
  db: D1Database,
  opts: {
    readonly idempotencyKey: string;
    readonly causalEventId: string | null;
    readonly sponsorId: string;
    readonly recipientEmail: string;
    readonly rendered: RenderedTransactionalEmail;
    readonly agoraOrigin: string;
    readonly nowIso: string;
    readonly maxAttempts?: number;
  },
): Promise<D1PreparedStatement> {
  if (!isValidEmailAddress(opts.recipientEmail)) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_RECIPIENT_INVALID",
      "Recipient must be a syntactically valid, CRLF-free email address (<= 254 chars).",
    );
  }
  assertEmailContentSafe({
    emailClass: opts.rendered.emailClass,
    subject: opts.rendered.subject,
    textBody: opts.rendered.textBody,
    htmlBody: opts.rendered.htmlBody,
    actionUrl: opts.rendered.actionUrl,
    listUnsubscribeUrl: opts.rendered.listUnsubscribeUrl,
    agoraOrigin: opts.agoraOrigin,
  });

  const recipientHash = await sha256Hex(opts.recipientEmail.trim().toLowerCase());
  const maxAttempts = opts.maxAttempts ?? DEFAULT_EMAIL_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_TEMPLATE_INCOMPLETE",
      "maxAttempts must be an integer between 1 and 16.",
    );
  }

  return db
    .prepare(
      `INSERT OR IGNORE INTO transactional_email_outbox (
         idempotency_key, causal_event_id, sponsor_id, recipient_hash, email_class,
         subject, text_body, html_body, action_url, list_unsubscribe_url, state, attempts, max_attempts,
         next_retry_at, provider_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.idempotencyKey,
      opts.causalEventId,
      opts.sponsorId,
      recipientHash,
      opts.rendered.emailClass,
      opts.rendered.subject,
      opts.rendered.textBody,
      opts.rendered.htmlBody,
      opts.rendered.actionUrl,
      opts.rendered.listUnsubscribeUrl ?? null,
      maxAttempts,
      opts.nowIso,
      TRANSACTIONAL_EMAIL_PROVIDER,
      opts.nowIso,
      opts.nowIso,
    );
}

export interface SponsorEmailPreference {
  readonly sponsor_id: string;
  readonly digest_opt_in: boolean;
  readonly digest_unsubscribed_at: string | null;
  readonly has_notification_email: boolean;
  readonly updated_at: string | null;
}

/** Read sponsor email preference metadata (never exposes plaintext email address). */
export async function getSponsorEmailPreference(
  db: D1Database,
  sponsorId: string,
): Promise<SponsorEmailPreference> {
  const row = await db
    .prepare(
      `SELECT sponsor_id, notification_email, digest_opt_in, digest_unsubscribed_at, updated_at
       FROM email_preferences WHERE sponsor_id = ?`,
    )
    .bind(sponsorId)
    .first<{
      sponsor_id: string;
      notification_email: string | null;
      digest_opt_in: number;
      digest_unsubscribed_at: string | null;
      updated_at: string;
    }>();
  if (!row) {
    return {
      sponsor_id: sponsorId,
      digest_opt_in: false,
      digest_unsubscribed_at: null,
      has_notification_email: false,
      updated_at: null,
    };
  }
  return {
    sponsor_id: row.sponsor_id,
    digest_opt_in: row.digest_opt_in === 1,
    digest_unsubscribed_at: row.digest_unsubscribed_at,
    has_notification_email: row.notification_email !== null && row.notification_email.length > 0,
    updated_at: row.updated_at,
  };
}

/** Update a sponsor's opt-in digest preference (and optional verified notification email); unsubscribe takes effect immediately. */
export async function setSponsorDigestPreference(
  db: D1Database,
  opts: {
    readonly sponsorId: string;
    readonly optIn: boolean;
    readonly notificationEmail?: string | null;
    readonly nowIso: string;
  },
): Promise<{ readonly updated: boolean; readonly tombstoned: boolean }> {
  if (
    opts.notificationEmail !== undefined &&
    opts.notificationEmail !== null &&
    !isValidEmailAddress(opts.notificationEmail)
  ) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_RECIPIENT_INVALID",
      "Notification email must be a valid, CRLF-free address (<= 254 chars) or null.",
    );
  }

  // Never resurrect `email_preferences` for an already-tombstoned sponsor (GDPR/retention boundary).
  const sponsorRow = await db
    .prepare(`SELECT tombstoned_at FROM sponsors WHERE sponsor_id = ?`)
    .bind(opts.sponsorId)
    .first<{ tombstoned_at: number | null }>();
  if (sponsorRow?.tombstoned_at !== null && sponsorRow?.tombstoned_at !== undefined) {
    if (!opts.optIn) {
      await db
        .prepare(
          `UPDATE transactional_email_outbox
           SET state = 'suppressed_unsubscribed', updated_at = ?
           WHERE sponsor_id = ? AND email_class = 'opt_in_digest' AND state = 'pending'`,
        )
        .bind(opts.nowIso, opts.sponsorId)
        .run();
    }
    return { updated: false, tombstoned: true };
  }

  const hasExplicitEmail = opts.notificationEmail !== undefined;
  const normalizedEmail =
    typeof opts.notificationEmail === "string" ? opts.notificationEmail.trim().toLowerCase() : null;

  // Atomically guard against concurrent account deletion (tombstoned_at set
  // between the pre-check and this write) so PII can never resurrect after deletion.
  const upserted = await db
    .prepare(
      `INSERT INTO email_preferences (sponsor_id, notification_email, digest_opt_in, digest_unsubscribed_at, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NOT NULL
       )
       ON CONFLICT(sponsor_id) DO UPDATE SET
         notification_email = CASE WHEN ? = 1 THEN excluded.notification_email ELSE email_preferences.notification_email END,
         digest_opt_in = excluded.digest_opt_in,
         digest_unsubscribed_at = CASE WHEN excluded.digest_opt_in = 0 THEN excluded.updated_at ELSE NULL END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      opts.sponsorId,
      normalizedEmail,
      opts.optIn ? 1 : 0,
      opts.optIn ? null : opts.nowIso,
      opts.nowIso,
      opts.sponsorId,
      hasExplicitEmail ? 1 : 0,
    )
    .run();

  if (!opts.optIn) {
    // Immediately suppress any still-pending opt_in_digest rows (never touches security/moderation/enrollment).
    await db
      .prepare(
        `UPDATE transactional_email_outbox
         SET state = 'suppressed_unsubscribed', updated_at = ?
         WHERE sponsor_id = ? AND email_class = 'opt_in_digest' AND state = 'pending'`,
      )
      .bind(opts.nowIso, opts.sponsorId)
      .run();
  }
  if ((upserted.meta?.changes ?? 0) === 0) {
    return { updated: false, tombstoned: true };
  }
  return { updated: true, tombstoned: false };
}

export interface EmailTransportSendRequest {
  readonly idempotencyKey: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly listUnsubscribe?: string;
}

export type EmailTransportSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly retryable: boolean; readonly errorCode: string };

export interface TransactionalEmailTransport {
  send(req: EmailTransportSendRequest): Promise<EmailTransportSendResult>;
}

/** Native-fetch Resend REST API transport (zero third-party SDK dependencies). */
export function createResendFetchTransport(opts: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}): TransactionalEmailTransport {
  const endpoint = opts.endpoint ?? RESEND_API_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async send(req) {
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": req.idempotencyKey,
        };
        const payload: Record<string, unknown> = {
          from: req.from,
          to: [req.to],
          subject: req.subject,
          text: req.text,
          html: req.html,
        };
        if (req.listUnsubscribe) {
          payload.headers = {
            "List-Unsubscribe": `<${req.listUnsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          };
        }
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          let data: unknown;
          try {
            data = await res.json();
          } catch {
            return { ok: false, retryable: true, errorCode: "PROVIDER_MISSING_MESSAGE_ID" };
          }
          if (
            typeof data === "object" &&
            data !== null &&
            typeof (data as { id?: unknown }).id === "string" &&
            (data as { id: string }).id.length > 0
          ) {
            return { ok: true, providerMessageId: (data as { id: string }).id };
          }
          return { ok: false, retryable: true, errorCode: "PROVIDER_MISSING_MESSAGE_ID" };
        }
        void res.body?.cancel().catch(() => undefined);
        const retryable = res.status === 429 || res.status >= 500;
        return { ok: false, retryable, errorCode: `PROVIDER_HTTP_${res.status}` };
      } catch {
        return { ok: false, retryable: true, errorCode: "PROVIDER_NETWORK_ERROR" };
      }
    },
  };
}

export interface EmailOperatorAlert {
  readonly type: "ops7.email_alert";
  readonly severity: "warn" | "critical";
  readonly code:
    | "EMAIL_DEAD_LETTERED"
    | "EMAIL_SUSTAINED_FAILURE"
    | "EMAIL_SPEND_WARN"
    | "EMAIL_SPEND_CAP_REACHED";
  readonly month_utc: string;
  readonly count: number;
  readonly detail: string;
}

export interface EmailDrainSummary {
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly suppressedUnsubscribed: number;
  readonly deferredSpendCap: number;
  readonly alerts: readonly EmailOperatorAlert[];
}

interface OutboxRow {
  readonly id: number;
  readonly idempotency_key: string;
  readonly sponsor_id: string;
  readonly email_class: TransactionalEmailClass;
  readonly subject: string;
  readonly text_body: string;
  readonly html_body: string;
  readonly action_url: string;
  readonly list_unsubscribe_url: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
}

/**
 * Drain due rows from `transactional_email_outbox` with idempotency, unsubscribe
 * enforcement, monthly spend-cap enforcement, bounded exponential retry/backoff,
 * visible dead-letter transitions, and operator alert emission.
 *
 * Provider outage NEVER throws out of `drainTransactionalEmailOutbox`: rows stay
 * visible as pending (with next_retry_at) or `dead_letter` while the sponsor
 * console remains canonical.
 */
export async function drainTransactionalEmailOutbox(
  db: D1Database,
  opts: {
    readonly transport: TransactionalEmailTransport;
    readonly fromAddress: string;
    readonly agoraOrigin: string;
    /** Resolve live sponsor email address at send time (never persisted in outbox logs). */
    readonly resolveRecipientEmail: (sponsorId: string) => Promise<string | null>;
    readonly nowMs?: number;
    readonly limit?: number;
    readonly monthlyCap?: number;
    readonly warnThreshold?: number;
    readonly onAlert?: (alert: EmailOperatorAlert) => void;
  },
): Promise<EmailDrainSummary> {
  if (!isSafeHeaderValue(opts.fromAddress)) {
    throw new TransactionalEmailPolicyError(
      "EMAIL_RECIPIENT_INVALID",
      "fromAddress must be non-empty and free of CRLF characters.",
    );
  }
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntilIso = new Date(nowMs + DELIVERY_LEASE_MS).toISOString();
  const monthUtc = nowIso.slice(0, 7);
  const limit = opts.limit ?? 25;
  const monthlyCap = opts.monthlyCap ?? DEFAULT_EMAIL_MONTHLY_CAP;
  const warnThreshold = opts.warnThreshold ?? DEFAULT_EMAIL_WARN_THRESHOLD;
  const alerts: EmailOperatorAlert[] = [];
  const emitAlert = (alert: EmailOperatorAlert) => {
    alerts.push(alert);
    opts.onAlert?.(alert);
  };

  await db
    .prepare(
      `INSERT OR IGNORE INTO email_spend_counters (month_utc, sent_count, monthly_cap, warn_threshold, updated_at)
       VALUES (?, 0, ?, ?, ?)`,
    )
    .bind(monthUtc, monthlyCap, warnThreshold, nowIso)
    .run();

  const spendRow = await db
    .prepare(`SELECT sent_count FROM email_spend_counters WHERE month_utc = ?`)
    .bind(monthUtc)
    .first<{ sent_count: number }>();
  let sentCount = spendRow?.sent_count ?? 0;

  const { results } = await db
    .prepare(
      `SELECT id, idempotency_key, sponsor_id, email_class, subject, text_body, html_body, action_url, list_unsubscribe_url, attempts, max_attempts
       FROM transactional_email_outbox
       WHERE state = 'pending' AND next_retry_at <= ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<OutboxRow>();

  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;
  let suppressedUnsubscribed = 0;
  let deferredSpendCap = 0;
  let consecutiveFailures = 0;

  for (const row of results) {
    // 1. Honor explicit digest opt-in / immediate unsubscribe (never suppresses security/moderation/enrollment).
    if (row.email_class === "opt_in_digest") {
      const pref = await db
        .prepare(`SELECT digest_opt_in FROM email_preferences WHERE sponsor_id = ?`)
        .bind(row.sponsor_id)
        .first<{ digest_opt_in: number }>();
      if (pref?.digest_opt_in !== 1) {
        const suppressed = await db
          .prepare(
            `UPDATE transactional_email_outbox
             SET state = 'suppressed_unsubscribed', updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
          )
          .bind(nowIso, row.id, nowIso)
          .run();
        if ((suppressed.meta?.changes ?? 0) === 1) {
          suppressedUnsubscribed += 1;
        }
        continue;
      }
    }

    // 2. Re-read live monthly spend counter right before dispatch so overlapping
    //    drainers cannot rely on a stale pre-loop count and exceed monthlyCap.
    const liveSpendRow = await db
      .prepare(`SELECT sent_count FROM email_spend_counters WHERE month_utc = ?`)
      .bind(monthUtc)
      .first<{ sent_count: number }>();
    sentCount = liveSpendRow?.sent_count ?? sentCount;

    if (sentCount >= monthlyCap) {
      const deferred = await db
        .prepare(
          `UPDATE transactional_email_outbox
           SET state = 'deferred_spend_cap', last_error_code = 'MONTHLY_SPEND_CAP_REACHED', updated_at = ?
           WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
        )
        .bind(nowIso, row.id, nowIso)
        .run();
      if ((deferred.meta?.changes ?? 0) === 1) {
        deferredSpendCap += 1;
        if (deferredSpendCap === 1) {
          emitAlert({
            type: "ops7.email_alert",
            severity: "critical",
            code: "EMAIL_SPEND_CAP_REACHED",
            month_utc: monthUtc,
            count: sentCount,
            detail: `Monthly transactional email cap (${monthlyCap}) reached; console remains canonical.`,
          });
        }
      }
      continue;
    }

    // 3. Re-verify egress safety right before network dispatch (defense in depth).
    try {
      assertEmailContentSafe({
        emailClass: row.email_class,
        subject: row.subject,
        textBody: row.text_body,
        htmlBody: row.html_body,
        actionUrl: row.action_url,
        listUnsubscribeUrl: row.list_unsubscribe_url,
        agoraOrigin: opts.agoraOrigin,
      });
    } catch {
      const dl = await db
        .prepare(
          `UPDATE transactional_email_outbox
           SET state = 'dead_letter', last_error_code = 'EGRESS_SAFETY_REFUSED', dead_lettered_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
        )
        .bind(nowIso, nowIso, row.id, nowIso)
        .run();
      if ((dl.meta?.changes ?? 0) === 1) {
        deadLettered += 1;
        emitAlert({
          type: "ops7.email_alert",
          severity: "critical",
          code: "EMAIL_DEAD_LETTERED",
          month_utc: monthUtc,
          count: deadLettered,
          detail: `Outbox row ${row.id} failed pre-dispatch egress safety check and was dead-lettered.`,
        });
      }
      continue;
    }

    // 4. Resolve recipient address dynamically; transient lookup errors back off
    //    cleanly instead of aborting the batch, while missing addresses dead-letter.
    let recipient: string | null;
    try {
      recipient = await opts.resolveRecipientEmail(row.sponsor_id);
    } catch {
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= row.max_attempts) {
        const dl = await db
          .prepare(
            `UPDATE transactional_email_outbox
             SET state = 'dead_letter', attempts = attempts + 1, last_error_code = 'RECIPIENT_LOOKUP_ERROR',
                 dead_lettered_at = ?, updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
          )
          .bind(nowIso, nowIso, row.id, nowIso)
          .run();
        if ((dl.meta?.changes ?? 0) === 1) {
          deadLettered += 1;
        }
      } else {
        const backoffMs = Math.min(
          EMAIL_MAX_BACKOFF_MS,
          EMAIL_BASE_BACKOFF_MS * 2 ** (nextAttempts - 1),
        );
        const nextRetryIso = new Date(nowMs + backoffMs).toISOString();
        const retriedRes = await db
          .prepare(
            `UPDATE transactional_email_outbox
             SET attempts = attempts + 1, next_retry_at = ?, last_error_code = 'RECIPIENT_LOOKUP_ERROR',
                 updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
          )
          .bind(nextRetryIso, nowIso, row.id, nowIso)
          .run();
        if ((retriedRes.meta?.changes ?? 0) === 1) {
          retried += 1;
        }
      }
      continue;
    }
    if (!recipient || !isValidEmailAddress(recipient)) {
      const dl = await db
        .prepare(
          `UPDATE transactional_email_outbox
           SET state = 'dead_letter', last_error_code = 'RECIPIENT_UNAVAILABLE', dead_lettered_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
        )
        .bind(nowIso, nowIso, row.id, nowIso)
        .run();
      if ((dl.meta?.changes ?? 0) === 1) {
        deadLettered += 1;
      }
      continue;
    }

    // 5. Claim an atomic delivery lease BEFORE calling the external HTTP provider so
    //    overlapping scheduled ticks cannot double-send or double-count spend.
    const claimed = await db
      .prepare(
        `UPDATE transactional_email_outbox
         SET next_retry_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND next_retry_at <= ?`,
      )
      .bind(leaseUntilIso, nowIso, row.id, nowIso)
      .run();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      continue;
    }

    let sendRes: EmailTransportSendResult;
    try {
      sendRes = await opts.transport.send({
        idempotencyKey: row.idempotency_key,
        from: opts.fromAddress,
        to: recipient,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body,
        ...(row.list_unsubscribe_url ? { listUnsubscribe: row.list_unsubscribe_url } : {}),
      });
    } catch {
      sendRes = { ok: false, retryable: true, errorCode: "TRANSPORT_THROW" };
    }

    if (sendRes.ok) {
      consecutiveFailures = 0;
      // Atomically mark delivered and increment monthly spend in one D1 batch
      // transaction so a crash or retry can never drift delivery vs spend count.
      const batchRes = await db.batch([
        db
          .prepare(
            `UPDATE transactional_email_outbox
             SET state = 'delivered', attempts = attempts + 1, provider_message_id = ?,
                 last_error_code = NULL, delivered_at = ?, updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at = ?`,
          )
          .bind(sendRes.providerMessageId, nowIso, nowIso, row.id, leaseUntilIso),
        db
          .prepare(
            `UPDATE email_spend_counters
             SET sent_count = sent_count + 1, updated_at = ?
             WHERE month_utc = ?
               AND EXISTS (
                 SELECT 1 FROM transactional_email_outbox
                 WHERE id = ? AND state = 'delivered' AND delivered_at = ? AND provider_message_id = ?
               )`,
          )
          .bind(nowIso, monthUtc, row.id, nowIso, sendRes.providerMessageId),
      ]);
      const deliveredRes = batchRes[0];
      if ((deliveredRes?.meta?.changes ?? 0) === 1) {
        sentCount += 1;
        delivered += 1;
        if (sentCount === warnThreshold) {
          emitAlert({
            type: "ops7.email_alert",
            severity: "warn",
            code: "EMAIL_SPEND_WARN",
            month_utc: monthUtc,
            count: sentCount,
            detail: `Monthly transactional email volume reached warning threshold (${warnThreshold}/${monthlyCap}).`,
          });
        }
      }
    } else {
      const nextAttempts = row.attempts + 1;
      consecutiveFailures += 1;
      if (!sendRes.retryable || nextAttempts >= row.max_attempts) {
        const dl = await db
          .prepare(
            `UPDATE transactional_email_outbox
             SET state = 'dead_letter', attempts = attempts + 1, last_error_code = ?, dead_lettered_at = ?, updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at = ?`,
          )
          .bind(sendRes.errorCode, nowIso, nowIso, row.id, leaseUntilIso)
          .run();
        if ((dl.meta?.changes ?? 0) === 1) {
          deadLettered += 1;
          emitAlert({
            type: "ops7.email_alert",
            severity: "critical",
            code: "EMAIL_DEAD_LETTERED",
            month_utc: monthUtc,
            count: deadLettered,
            detail: `Email outbox row ${row.id} dead-lettered after ${nextAttempts} attempts (${sendRes.errorCode}).`,
          });
        }
      } else {
        const backoffMs = Math.min(
          EMAIL_MAX_BACKOFF_MS,
          EMAIL_BASE_BACKOFF_MS * 2 ** (nextAttempts - 1),
        );
        const nextRetryIso = new Date(nowMs + backoffMs).toISOString();
        const retriedRes = await db
          .prepare(
            `UPDATE transactional_email_outbox
             SET attempts = attempts + 1, next_retry_at = ?, last_error_code = ?, updated_at = ?
             WHERE id = ? AND state = 'pending' AND next_retry_at = ?`,
          )
          .bind(nextRetryIso, sendRes.errorCode, nowIso, row.id, leaseUntilIso)
          .run();
        if ((retriedRes.meta?.changes ?? 0) === 1) {
          retried += 1;
        }
      }
      if (consecutiveFailures === SUSTAINED_FAILURE_ALERT_THRESHOLD) {
        emitAlert({
          type: "ops7.email_alert",
          severity: "critical",
          code: "EMAIL_SUSTAINED_FAILURE",
          month_utc: monthUtc,
          count: consecutiveFailures,
          detail: `Transactional email provider sustained ${consecutiveFailures} consecutive failures; console remains canonical.`,
        });
      }
    }
  }

  return {
    delivered,
    retried,
    deadLettered,
    suppressedUnsubscribed,
    deferredSpendCap,
    alerts,
  };
}

export interface EmailOutboxHealth {
  readonly pending: number;
  readonly delivered: number;
  readonly dead_letter: number;
  readonly suppressed_unsubscribed: number;
  readonly deferred_spend_cap: number;
  readonly degraded: boolean;
}

/** Visible console/operator outbox health snapshot (never leaks recipient emails or bodies). */
export async function readEmailOutboxHealth(db: D1Database): Promise<EmailOutboxHealth> {
  const { results } = await db
    .prepare(`SELECT state, COUNT(*) AS cnt FROM transactional_email_outbox GROUP BY state`)
    .all<{ state: string; cnt: number }>();
  const counts = new Map(results.map((r) => [r.state, Number(r.cnt)]));
  const pending = counts.get("pending") ?? 0;
  const delivered = counts.get("delivered") ?? 0;
  const deadLetter = counts.get("dead_letter") ?? 0;
  const suppressed = counts.get("suppressed_unsubscribed") ?? 0;
  const deferred = counts.get("deferred_spend_cap") ?? 0;
  return {
    pending,
    delivered,
    dead_letter: deadLetter,
    suppressed_unsubscribed: suppressed,
    deferred_spend_cap: deferred,
    degraded: deadLetter > 0 || deferred > 0,
  };
}

export interface ScheduledEmailReconcileResult {
  readonly enabled: boolean;
  readonly delivered: number;
  readonly retried: number;
  readonly dead_lettered: number;
  readonly suppressed_unsubscribed: number;
  readonly deferred_spend_cap: number;
  readonly alerts: number;
}

/**
 * Scheduled Worker entrypoint (OPS.7): drains pending transactional email rows
 * ONLY when `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, and a trusted `AGORA_ORIGIN`
 * are configured. Never throws on provider outage so ledger/backup crons stay healthy.
 */
export async function reconcileTransactionalEmailOutbox(
  env: Pick<
    Env,
    "DB" | "RESEND_API_KEY" | "EMAIL_FROM_ADDRESS" | "AGORA_ORIGIN" | "EMAIL_MONTHLY_CAP"
  >,
): Promise<ScheduledEmailReconcileResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromAddress = env.EMAIL_FROM_ADDRESS?.trim();
  const agoraOrigin = env.AGORA_ORIGIN?.trim();
  if (!apiKey || !fromAddress || !agoraOrigin || !isTrustedAgoraOrigin(agoraOrigin)) {
    return {
      enabled: false,
      delivered: 0,
      retried: 0,
      dead_lettered: 0,
      suppressed_unsubscribed: 0,
      deferred_spend_cap: 0,
      alerts: 0,
    };
  }
  const parsedCap =
    env.EMAIL_MONTHLY_CAP === undefined ? DEFAULT_EMAIL_MONTHLY_CAP : Number(env.EMAIL_MONTHLY_CAP);
  const monthlyCap =
    Number.isInteger(parsedCap) && parsedCap >= 0 ? parsedCap : DEFAULT_EMAIL_MONTHLY_CAP;

  const summary = await drainTransactionalEmailOutbox(env.DB, {
    transport: createResendFetchTransport({ apiKey }),
    fromAddress,
    agoraOrigin,
    monthlyCap,
    warnThreshold: monthlyCap === 0 ? 0 : Math.max(1, Math.floor(monthlyCap * 0.8)),
    resolveRecipientEmail: async (sponsorId) => {
      const row = await env.DB.prepare(
        `SELECT ep.notification_email
         FROM email_preferences ep
         LEFT JOIN sponsors s ON s.sponsor_id = ep.sponsor_id
         WHERE ep.sponsor_id = ?
           AND (s.sponsor_id IS NULL OR s.tombstoned_at IS NULL)`,
      )
        .bind(sponsorId)
        .first<{ notification_email: string | null }>();
      return row?.notification_email ?? null;
    },
    onAlert: (alert) => {
      console.error(JSON.stringify({ facility: "OPS.2a", ...alert }));
    },
  });
  return {
    enabled: true,
    delivered: summary.delivered,
    retried: summary.retried,
    dead_lettered: summary.deadLettered,
    suppressed_unsubscribed: summary.suppressedUnsubscribed,
    deferred_spend_cap: summary.deferredSpendCap,
    alerts: summary.alerts.length,
  };
}

/**
 * Best-effort, idempotent causal producer helper for the three mandatory
 * transactional classes (`enrollment_approval`, `security_alert`,
 * `moderation_notice`). Cleanly no-ops when `EMAIL_ACTION_LINK_SECRET`, a
 * trusted `AGORA_ORIGIN`, D1, or a non-tombstoned sponsor notification email
 * is absent. Never throws so transactional email never blocks primary writes.
 */
export async function enqueueSponsorNotificationIfConfigured(
  env: Pick<Partial<Env>, "DB" | "AGORA_ORIGIN" | "EMAIL_ACTION_LINK_SECRET"> | undefined,
  opts: {
    readonly db?: D1Database;
    readonly idempotencyKey: string;
    readonly causalEventId: string | null;
    readonly sponsorId: string;
    readonly emailClass: Exclude<TransactionalEmailClass, "opt_in_digest">;
    readonly actionPath: string;
    readonly summaryLabel: string;
    readonly referenceId: string;
    readonly occurredAtIso?: string;
  },
): Promise<{ readonly enqueued: boolean }> {
  try {
    const db = opts.db ?? env?.DB;
    const linkSecret = env?.EMAIL_ACTION_LINK_SECRET?.trim();
    const agoraOrigin = env?.AGORA_ORIGIN?.trim();
    if (
      !db ||
      !linkSecret ||
      linkSecret.length < MIN_LINK_SECRET_LENGTH ||
      !agoraOrigin ||
      !isTrustedAgoraOrigin(agoraOrigin)
    ) {
      return { enqueued: false };
    }

    const prefRow = await db
      .prepare(
        `SELECT ep.notification_email
         FROM email_preferences ep
         LEFT JOIN sponsors s ON s.sponsor_id = ep.sponsor_id
         WHERE ep.sponsor_id = ?
           AND ep.notification_email IS NOT NULL
           AND (s.sponsor_id IS NULL OR s.tombstoned_at IS NULL)`,
      )
      .bind(opts.sponsorId)
      .first<{ notification_email: string | null }>();
    const recipientEmail = prefRow?.notification_email?.trim();
    if (!recipientEmail || !isValidEmailAddress(recipientEmail)) {
      return { enqueued: false };
    }

    const nowIso = opts.occurredAtIso ?? new Date().toISOString();
    const rendered = await renderTransactionalEmail({
      emailClass: opts.emailClass,
      sponsorId: opts.sponsorId,
      agoraOrigin,
      actionPath: opts.actionPath,
      linkSecret,
      summaryLabel: opts.summaryLabel.slice(0, 160),
      referenceId: opts.referenceId.slice(0, 128),
      occurredAtIso: nowIso,
    });
    const stmt = await prepareEnqueueTransactionalEmail(db, {
      idempotencyKey: opts.idempotencyKey,
      causalEventId: opts.causalEventId,
      sponsorId: opts.sponsorId,
      recipientEmail,
      rendered,
      agoraOrigin,
      nowIso,
    });
    const res = await stmt.run();
    return { enqueued: (res.meta?.changes ?? 0) === 1 };
  } catch {
    return { enqueued: false };
  }
}
