/**
 * Mounted HTTP routes for OPS.7 Minimal Transactional Email (bead asimposiumorg-d5x).
 *
 * - Authenticated sponsor preferences (`GET/POST /v1/sponsors/email-preferences`):
 *   behind Agora's signed service envelope; never returns plaintext notification email.
 * - Authenticated operator outbox health (`GET /v1/operators/email-outbox/health`):
 *   aggregate state counts only (zero recipient emails or message bodies).
 * - Public RFC 8058 signed one-click digest unsubscribe (`POST /v1/email/unsubscribe`):
 *   verified in constant time against `env.EMAIL_ACTION_LINK_SECRET`; immediately
 *   suppresses pending `opt_in_digest` rows without affecting security/moderation notices.
 */

import { SponsorIdSchema } from "@asimposium/contracts";
import { Hono } from "hono";
import { z } from "zod";
import {
  cancelUnconsumedRequestBody,
  parseAuthenticatedJsonBytes,
  parseExactJsonBytes,
  readBoundedRequestBody,
} from "../auth/http.ts";
import { requestBodyTooLargeProblem } from "../auth/refusal.ts";
import type { EnrollmentRouterOptions } from "../enrollment/router.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import {
  getSponsorEmailPreference,
  readEmailOutboxHealth,
  setSponsorDigestPreference,
  TransactionalEmailPolicyError,
  verifySignedAgoraActionToken,
} from "./transactional-email.ts";

const DEFAULT_UNSUBSCRIBE_PATH = "/console/email-preferences/unsubscribe";
const MAX_UNSUBSCRIBE_BODY_BYTES = 2048;

const SponsorEmailPreferencesUpdateSchema = z
  .object({
    digest_opt_in: z.boolean(),
    notification_email: z.string().min(3).max(254).nullable().optional(),
  })
  .strict();

const PublicUnsubscribeBodySchema = z
  .object({
    sponsor_id: SponsorIdSchema,
    ref: z.string().min(1).max(160),
    sig: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  })
  .strict();

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function hasQueryParams(request: Request): boolean {
  return new URL(request.url).search !== "";
}

function isJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function queryNotAllowedProblem(path: string): Response {
  return privateResponse(
    validatedProblem({
      status: 422,
      code: "SCHEMA_INVALID",
      title: "Query parameters are not accepted on this route",
      detail: `${path} accepts no URL query parameters.`,
      fixHint: `Remove query parameters from ${path} and send request fields in the JSON body.`,
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/problem.v1.json",
        example: { path },
      },
    }),
  );
}

function jsonContentTypeRequiredProblem(path: string): Response {
  return privateResponse(
    validatedProblem({
      status: 415,
      code: "SCHEMA_INVALID",
      title: "Content-Type application/json is required",
      detail: `${path} requires a Content-Type: application/json request body.`,
      fixHint: "Send header Content-Type: application/json with a JSON object body.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/problem.v1.json",
        example: { path, content_type: "application/json" },
      },
    }),
  );
}

export function createTransactionalEmailApp(
  options: Pick<EnrollmentRouterOptions, "db" | "verifiedSponsor" | "verifiedOperator">,
): Hono {
  const app = new Hono();

  app.get("/v1/sponsors/email-preferences", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/sponsors/email-preferences");
    }
    if (!options.verifiedSponsor || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "ENROLLMENT_UNAVAILABLE",
          title: "Email preferences unavailable",
          detail: "Sponsor authentication or storage is unavailable on this Worker.",
          fixHint: "Configure sponsor service-envelope verification and D1, then retry.",
        }),
      );
    }
    const authenticated = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/email-preferences",
      "email-preferences.read",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (
      authenticated.principal.type !== "sponsor" ||
      !SponsorIdSchema.safeParse(authenticated.principal.sponsorId).success
    ) {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "A sponsor principal is required",
          detail: "Only an authenticated sponsor may read email preferences.",
          fixHint: "Use the authenticated sponsor console.",
        }),
      );
    }
    const pref = await getSponsorEmailPreference(options.db, authenticated.principal.sponsorId);
    return privateResponse(c.json(pref, 200));
  });

  app.post("/v1/sponsors/email-preferences", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/sponsors/email-preferences");
    }
    if (!isJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredProblem("/v1/sponsors/email-preferences");
    }
    if (!options.verifiedSponsor || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "ENROLLMENT_UNAVAILABLE",
          title: "Email preferences unavailable",
          detail: "Sponsor authentication or storage is unavailable on this Worker.",
          fixHint: "Configure sponsor service-envelope verification and D1, then retry.",
        }),
      );
    }
    const authenticated = await options.verifiedSponsor(
      c.req.raw,
      "/v1/sponsors/email-preferences",
      "email-preferences.write",
    );
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (
      authenticated.principal.type !== "sponsor" ||
      !SponsorIdSchema.safeParse(authenticated.principal.sponsorId).success
    ) {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "A sponsor principal is required",
          detail: "Only an authenticated sponsor may update email preferences.",
          fixHint: "Use the authenticated sponsor console.",
        }),
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = parseAuthenticatedJsonBytes(authenticated.rawBody);
    } catch {
      return privateResponse(
        validatedProblem({
          status: 400,
          code: "MALFORMED_JSON",
          title: "Malformed JSON request",
          detail: "The email preferences body must be valid JSON.",
          fixHint: "Send a JSON object with digest_opt_in boolean.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: { digest_opt_in: false },
          },
        }),
      );
    }
    const validated = SponsorEmailPreferencesUpdateSchema.safeParse(parsedJson);
    if (!validated.success) {
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid email preferences payload",
          detail:
            "Provide digest_opt_in (boolean) and optional notification_email (valid address or null).",
          fixHint: 'Send {"digest_opt_in": false}.',
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: { digest_opt_in: false, notification_email: "sponsor@example.org" },
          },
        }),
      );
    }
    const nowIso = new Date().toISOString();
    try {
      const writeResult = await setSponsorDigestPreference(options.db, {
        sponsorId: authenticated.principal.sponsorId,
        optIn: validated.data.digest_opt_in,
        ...(validated.data.notification_email !== undefined
          ? { notificationEmail: validated.data.notification_email }
          : {}),
        nowIso,
      });
      if (writeResult.tombstoned) {
        return privateResponse(
          validatedProblem({
            status: 403,
            code: "UNAUTHORIZED",
            title: "Sponsor account is closed",
            detail: "Deleted sponsor accounts cannot update email preferences.",
            fixHint: "No further email will be sent to a deleted sponsor account.",
          }),
        );
      }
    } catch (error) {
      if (error instanceof TransactionalEmailPolicyError) {
        return privateResponse(
          validatedProblem({
            status: 422,
            code: "SCHEMA_INVALID",
            title: "Invalid notification email",
            detail: "The supplied notification email address did not pass validation.",
            fixHint: "Provide a syntactically valid email address or null to clear it.",
            rule: "A5",
            extensions: {
              schema: "https://a.asimposium.org/schemas/problem.v1.json",
              example: { digest_opt_in: true, notification_email: "sponsor@example.org" },
            },
          }),
        );
      }
      throw error;
    }
    const updated = await getSponsorEmailPreference(options.db, authenticated.principal.sponsorId);
    return privateResponse(c.json(updated, 200));
  });

  app.get("/v1/operators/email-outbox/health", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/operators/email-outbox/health");
    }
    if (!options.verifiedOperator || !options.db) {
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "ENROLLMENT_UNAVAILABLE",
          title: "Operator email outbox health unavailable",
          detail: "Operator authentication or storage is unavailable on this Worker.",
          fixHint: "Configure operator principals and D1, then retry.",
        }),
      );
    }
    const authenticated = await options.verifiedOperator(
      c.req.raw,
      "/v1/operators/email-outbox/health",
      "operator.email-outbox.read",
    );
    cancelUnconsumedRequestBody(c.req.raw);
    if (authenticated instanceof Response) return privateResponse(authenticated);
    if (authenticated.principal.type !== "operator") {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "WRONG_PRINCIPAL",
          title: "An operator principal is required",
          detail: "Only an authenticated operator may inspect email outbox health.",
          fixHint: "Use an operator-authorized request.",
        }),
      );
    }
    const health = await readEmailOutboxHealth(options.db);
    return privateResponse(c.json(health, 200));
  });

  return app;
}

/**
 * Public signed one-click digest unsubscribe endpoint (RFC 8058 compatible).
 * Requires `env.EMAIL_ACTION_LINK_SECRET`; verifies HMAC signature in constant
 * time and immediately suppresses pending `opt_in_digest` rows without touching
 * required transactional security or moderation notices.
 */
export function createPublicEmailUnsubscribeRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/v1/email/unsubscribe", async (c) => {
    if (hasQueryParams(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return queryNotAllowedProblem("/v1/email/unsubscribe");
    }
    if (!isJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredProblem("/v1/email/unsubscribe");
    }
    const secret = c.env.EMAIL_ACTION_LINK_SECRET?.trim();
    if (!secret || secret.length < 16 || !c.env.DB) {
      cancelUnconsumedRequestBody(c.req.raw);
      return privateResponse(
        validatedProblem({
          status: 503,
          code: "INTERNAL_ERROR",
          title: "Email unsubscribe verification is not configured",
          detail: "Signed email link verification or storage is unavailable on this Worker.",
          fixHint: "Update your digest preferences directly in the Agora Sponsor Console.",
        }),
      );
    }

    const bounded = await readBoundedRequestBody(c.req.raw, MAX_UNSUBSCRIBE_BODY_BYTES);
    if (!bounded.ok) {
      if (bounded.reason === "too-large") {
        return privateResponse(requestBodyTooLargeProblem());
      }
      return privateResponse(
        validatedProblem({
          status: 400,
          code: "MALFORMED_JSON",
          title: "Malformed unsubscribe request",
          detail: "Expected an uncompressed JSON body with sponsor_id, ref, and sig.",
          fixHint: "Use the signed unsubscribe link from your digest email.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: {
              sponsor_id: "usr_example_sponsor",
              ref: "unsub-usr_example_sponsor",
              sig: "0123456789abcdef0123456789abcdef",
            },
          },
        }),
      );
    }

    let rawJson: unknown;
    try {
      rawJson = parseExactJsonBytes(bounded.bytes);
    } catch {
      return privateResponse(
        validatedProblem({
          status: 400,
          code: "MALFORMED_JSON",
          title: "Malformed unsubscribe request",
          detail: "Expected JSON with sponsor_id, ref, and sig.",
          fixHint: "Use the signed unsubscribe link from your digest email.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: {
              sponsor_id: "usr_example_sponsor",
              ref: "unsub-usr_example_sponsor",
              sig: "0123456789abcdef0123456789abcdef",
            },
          },
        }),
      );
    }

    const parsed = PublicUnsubscribeBodySchema.safeParse(rawJson);
    if (!parsed.success) {
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid unsubscribe parameters",
          detail: "sponsor_id, ref, and sig are required.",
          fixHint: "Use the signed unsubscribe link from your digest email.",
          rule: "A5",
          extensions: {
            schema: "https://a.asimposium.org/schemas/problem.v1.json",
            example: {
              sponsor_id: "usr_example_sponsor",
              ref: "unsub-usr_example_sponsor",
              sig: "0123456789abcdef0123456789abcdef",
            },
          },
        }),
      );
    }

    const expectedRef = `unsub-${parsed.data.sponsor_id}`;
    const valid =
      parsed.data.ref === expectedRef &&
      (await verifySignedAgoraActionToken({
        sponsorId: parsed.data.sponsor_id,
        actionPath: DEFAULT_UNSUBSCRIBE_PATH,
        referenceId: parsed.data.ref,
        sig: parsed.data.sig,
        linkSecret: secret,
      }));
    if (!valid) {
      return privateResponse(
        validatedProblem({
          status: 403,
          code: "UNAUTHORIZED",
          title: "Invalid unsubscribe signature",
          detail: "The unsubscribe signature could not be verified.",
          fixHint: "Sign in to asimposium.org/console to manage email preferences.",
        }),
      );
    }

    const nowIso = new Date().toISOString();
    await setSponsorDigestPreference(c.env.DB, {
      sponsorId: parsed.data.sponsor_id,
      optIn: false,
      nowIso,
    });
    return privateResponse(
      c.json(
        {
          unsubscribed: true,
          sponsor_id: parsed.data.sponsor_id,
          digest_opt_in: false,
          updated_at: nowIso,
        },
        200,
      ),
    );
  });

  return app;
}
