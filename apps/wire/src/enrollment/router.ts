import {
  DeviceCodeStartResponseSchema,
  DeviceLookupResponseSchema,
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  EnrollmentIdSchema,
  encodeOperatorFellowCapAuditCursor,
  encodeSponsorFellowCursor,
  MintEnrollmentRequestSchema,
  MintEnrollmentResponseSchema,
  OperatorFellowCapAuditPageResponseSchema,
  OperatorFellowCapOverrideRequestSchema,
  OperatorFellowCapOverrideResponseSchema,
  OperatorFellowCapStateResponseSchema,
  type ProblemCode,
  ProblemDocumentSchema,
  parseOperatorFellowCapAuditCursor,
  parseSponsorFellowCursor,
  SponsorBootstrapRequestSchema,
  SponsorBootstrapResponseSchema,
  SponsorCredentialRevokeRequestSchema,
  SponsorCredentialRevokeResponseSchema,
  SponsorEnrollmentDecisionCommandSchema,
  SponsorEnrollmentDecisionResponseSchema,
  SponsorFellowLifecycleRequestSchema,
  SponsorFellowLifecycleResponseSchema,
  SponsorFellowListResponseSchema,
  SponsorIdSchema,
  SponsorPanicRequestSchema,
  SponsorPanicResponseSchema,
  SponsorProposalListResponseSchema,
  stoaJoinUrl,
} from "@asimposium/contracts";
import { Hono } from "hono";

import {
  cancelUnconsumedRequestBody,
  parseExactJsonBytes,
  readBoundedRequestBody,
  parseAuthenticatedJsonBytes as verifiedJson,
} from "../auth/http.ts";
import {
  enrollmentCapsuleHtml,
  enrollmentCapsuleMarkdown,
  enrollmentCapsuleProjection,
} from "./capsule.ts";
import {
  EnrollmentError,
  type EnrollmentErrorCode,
  EnrollmentPersistenceError,
  type EnrollmentPrincipal,
  EnrollmentReplayConfigurationError,
  type EnrollmentResourceGrants,
  type EnrollmentService,
  SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS,
  SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS,
  SponsorEnrollmentRateLimitError,
  type SponsorFellowRecord,
} from "./service.ts";

/**
 * Schema identifiers are canonical production URIs on purpose: they name a
 * document version, not a destination, so a staging or loopback Worker must
 * still report the same `$id` a production one does. Anything an agent
 * *follows* — join URLs, `hello_url`, `next_actions` — comes from the
 * service's immutable configured origin instead, and never from the request.
 */
const ENROLLMENT_SCHEMA_URL = "https://a.asimposium.org/schemas/enrollment.v1.json";
const FRAGMENT_VALUE_PLACEHOLDER = "<value from the join URL fragment>";
export const MAX_ENROLLMENT_REQUEST_BODY_BYTES = 64 * 1024;

class EnrollmentRequestBodyTooLargeError extends Error {
  constructor() {
    super("enrollment request body exceeds its byte ceiling");
    this.name = "EnrollmentRequestBodyTooLargeError";
  }
}

/** Contract failures teach request shape; credential and state refusals stay coarse. */
function enrollmentContractFields(example: Record<string, unknown>): Record<string, unknown> {
  return { rule: "A5", schema: ENROLLMENT_SCHEMA_URL, example };
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

function requestEndsInDecodedSegment(request: Request, expected: string): boolean {
  const finalSegment = requestPath(request).split("/").at(-1);
  if (finalSegment === undefined) return false;
  try {
    return decodeURIComponent(finalSegment) === expected;
  } catch {
    return false;
  }
}

function idempotencyHeaderExample(request: Request): Record<string, unknown> {
  return {
    method: request.method,
    path: requestPath(request),
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "enrollment-01JXYZ4K6Q",
    },
  };
}

function idempotencyConflictExample(request: Request): Record<string, unknown> {
  return {
    ...idempotencyHeaderExample(request),
    body: "<the exact JSON body originally sent with this key>",
  };
}

export interface EnrollmentRouterOptions {
  readonly service: EnrollmentService;
  /**
   * Parent-supplied verified sponsor seam: authenticates the signed service
   * envelope for one exact route template and action. A returned `Response`
   * is the refusal to serve verbatim. On success it returns the sponsor and
   * the exact body bytes the signature covered — handlers must parse JSON
   * from those bytes, never re-read the (already consumed) request body.
   * When the seam is absent, sponsor routes answer 503 rather than ever
   * trusting a header.
   */
  readonly verifiedSponsor?: (
    request: Request,
    route: string,
    action: string,
  ) => Promise<
    { readonly principal: EnrollmentPrincipal; readonly rawBody: Uint8Array } | Response
  >;
  /**
   * Parent-supplied operator seam. It must authenticate an `operator` envelope
   * for this exact route/action and apply the Worker deployment's allowlist;
   * this router never accepts a caller-selected operator header.
   */
  readonly verifiedOperator?: (
    request: Request,
    route: string,
    action: string,
  ) => Promise<
    { readonly principal: EnrollmentPrincipal; readonly rawBody: Uint8Array } | Response
  >;
}

function problem(
  status: number,
  code: ProblemCode,
  title: string,
  detail: string,
  fixHint: string,
  extensions: Record<string, unknown> = {},
): Response {
  const document = ProblemDocumentSchema.parse({
    type: `https://asimposium.org/errors/${code}`,
    title,
    status,
    code,
    detail,
    fix_hint: fixHint,
    ...extensions,
  });
  return new Response(JSON.stringify(document), {
    status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function hasQuery(request: Request): boolean {
  return new URL(request.url).search !== "";
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  const [mediaType] = contentType.split(";", 1);
  return mediaType?.trim().toLowerCase() === "application/json";
}

function jsonContentTypeRequiredResponse(
  path: string,
  body: Record<string, unknown>,
  requiresIdempotencyKey = false,
): Response {
  return problem(
    415,
    "JSON_CONTENT_TYPE_REQUIRED",
    "JSON Content-Type required",
    "This write accepts a JSON document only when its media type is application/json.",
    "Set Content-Type: application/json and send the documented JSON body.",
    enrollmentContractFields({
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        ...(requiresIdempotencyKey ? { "Idempotency-Key": "enrollment-01JXYZ4K6Q" } : {}),
      },
      body,
    }),
  );
}

type CapsuleFace = "json" | "html" | "markdown";

const CAPSULE_FACE_MEDIA: Readonly<Record<CapsuleFace, string>> = {
  json: "application/json",
  html: "text/html",
  markdown: "text/markdown",
};

/** Parse one quality value. Invalid or duplicate q parameters refuse the range. */
function acceptQuality(parameters: readonly string[]): number {
  let quality: number | undefined;
  for (const parameter of parameters) {
    const [name, value, ...rest] = parameter.trim().split("=");
    if (name?.toLowerCase() !== "q") continue;
    if (quality !== undefined || value === undefined || rest.length !== 0) return 0;
    const normalized = value.trim();
    if (!/^(?:0(?:\.\d{0,3})?|\.\d{1,3}|1(?:\.0{0,3})?)$/.test(normalized)) return 0;
    quality = Number(normalized);
  }
  return quality ?? 1;
}

interface AcceptedMediaRange {
  readonly type: string;
  readonly subtype: string;
  readonly quality: number;
}

/** Split an HTTP list outside quoted strings, retaining escapes for later validation. */
function splitHeaderList(header: string, delimiter: "," | ";"): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of header) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  values.push(current.trim());
  return values;
}

function acceptedMediaRanges(accept: string): readonly AcceptedMediaRange[] {
  const ranges: AcceptedMediaRange[] = [];
  for (const item of splitHeaderList(accept, ",")) {
    const [mediaRange, ...parameters] = splitHeaderList(item, ";");
    const parts = mediaRange?.split("/") ?? [];
    if (parts.length !== 2) continue;
    const type = parts[0]?.trim().toLowerCase() ?? "";
    const subtype = parts[1]?.trim().toLowerCase() ?? "";
    if (type === "" || subtype === "" || (type === "*" && subtype !== "*")) continue;
    ranges.push({ type, subtype, quality: acceptQuality(parameters) });
  }
  return ranges;
}

/** Most-specific media ranges win; equal-quality faces prefer canonical Markdown. */
function selectCapsuleFace(accept: string): CapsuleFace {
  const ranges = acceptedMediaRanges(accept);
  const quality = new Map<CapsuleFace, number>();
  for (const face of Object.keys(CAPSULE_FACE_MEDIA) as CapsuleFace[]) {
    const [faceType, faceSubtype] = CAPSULE_FACE_MEDIA[face].split("/") as [string, string];
    let specificity = -1;
    let effectiveQuality = 0;
    for (const range of ranges) {
      const matchesType = range.type === "*" || range.type === faceType;
      const matchesSubtype = range.subtype === "*" || range.subtype === faceSubtype;
      if (!matchesType || !matchesSubtype) continue;
      const candidateSpecificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
      if (candidateSpecificity > specificity) {
        specificity = candidateSpecificity;
        effectiveQuality = range.quality;
      } else if (candidateSpecificity === specificity) {
        effectiveQuality = Math.max(effectiveQuality, range.quality);
      }
    }
    if (specificity >= 0) quality.set(face, effectiveQuality);
  }

  const highest = Math.max(0, ...quality.values());
  for (const face of ["markdown", "json", "html"] as const) {
    if ((quality.get(face) ?? 0) === highest && highest > 0) return face;
  }

  // Accept negotiation is a courtesy (Fable §7.3). If nothing supported is
  // acceptable, disregard the field and retain the canonical Markdown face.
  return "markdown";
}

/** GET uses weak comparison: W/"tag" and "tag" refer to the same face. */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return splitHeaderList(header, ",").some((candidate) => {
    if (candidate === "*") return true;
    const opaque = candidate.startsWith("W/") ? candidate.slice(2) : candidate;
    return opaque === etag;
  });
}

async function strongEtag(face: "json" | "html" | "markdown", body: string): Promise<string> {
  const material = new TextEncoder().encode(`${face}\n${body}`);
  const digest = await crypto.subtle.digest("SHA-256", material.buffer);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

function enrollmentErrorResponse(error: EnrollmentError, request: Request): Response {
  switch (error.code) {
    case "NAME_INVALID":
    case "MODEL_AS_NAME":
    case "HARNESS_AS_NAME":
    case "NAME_RESERVED":
      return problem(
        422,
        error.code,
        "Fellow name needs revision",
        "The requested public Fellow name cannot be used.",
        "Choose one of `suggestions` or supply another lowercase, hyphen-separated Fellow name.",
        {
          rule: "P-EN-NAME",
          schema: ENROLLMENT_SCHEMA_URL,
          example: { name: "orchid-vector" },
          suggestions: error.suggestions,
        },
      );
    case "NAME_TAKEN":
      if (requestEndsInDecodedSegment(request, "decision")) {
        return problem(
          422,
          error.code,
          "Fellow name is no longer available",
          "Another approved Fellow already owns the proposed public name.",
          "Deny this proposal, then have the agent start a new enrollment with one of `suggestions` or another available name; a sponsor decision cannot rename it.",
          {
            rule: "P-EN-NAME",
            schema: ENROLLMENT_SCHEMA_URL,
            example: {
              enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
              decision: "deny",
              step_up_authenticated_at: 1_786_800_000,
            },
            suggestions: error.suggestions,
          },
        );
      }
      return problem(
        422,
        error.code,
        "Fellow name needs revision",
        "The requested public Fellow name cannot be used.",
        "Choose one of `suggestions` or supply another lowercase, hyphen-separated Fellow name.",
        {
          rule: "P-EN-NAME",
          schema: ENROLLMENT_SCHEMA_URL,
          example: { name: "orchid-vector" },
          suggestions: error.suggestions,
        },
      );
    case "WRONG_PRINCIPAL":
      return problem(
        403,
        error.code,
        "Principal cannot perform this enrollment action",
        "This identity is not authorized for the requested enrollment action.",
        "Refresh the sponsor's pending proposal list and act only on a current card. Fellow-only routes require a valid Fellow bearer token.",
      );
    case "PROPOSAL_NOT_PENDING":
    case "PROPOSAL_EXPIRED":
      return problem(
        404,
        error.code,
        "No pending proposal here",
        "This enrollment proposal is not pending a decision.",
        "List pending proposals and decide one whose status is pending.",
      );
    case "DECISION_TARGET_MISMATCH":
      // Both compared values are caller-supplied, so this teaches without
      // disclosing whether either enrollment exists.
      return problem(
        422,
        error.code,
        "Decision does not name this enrollment",
        "The signed decision body names a different enrollment than the request path.",
        "Send the decision to the path of the enrollment named by `enrollment_id`, and sign that exact body.",
        {
          rule: "ADR-20",
          schema: ENROLLMENT_SCHEMA_URL,
          example: {
            enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
            decision: "approve",
            step_up_authenticated_at: 1_786_800_000,
          },
        },
      );
    case "DEVICE_CODE_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Device-code request body is invalid",
        "The JSON body does not match the proposal-carrying device-code contract.",
        "Send the proposed name, declared model and harness, and requested scopes in the documented JSON body.",
        enrollmentContractFields({
          name: "orchid-vector",
          model: "example-lab/orchid-1",
          harness: "codex",
          requested_scopes: ["review"],
        }),
      );
    case "DEVICE_LOOKUP_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Device lookup body is invalid",
        "The signed JSON body does not match the device lookup contract.",
        "Send the eight-character user code in its documented 4-4 form, then sign those exact bytes.",
        enrollmentContractFields({ user_code: "ABCD-2345" }),
      );
    case "REGISTRATION_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Fellow registration body is invalid",
        "The credential was verified, no proposal was created, and the JSON body does not match the strict Fellow registration contract.",
        "Correct the body, then reuse the same fragment secret and Idempotency-Key. Send only the documented enrollment id, proposed name, declared runtime, and optional declared runtime fields.",
        enrollmentContractFields({
          enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
          secret: FRAGMENT_VALUE_PLACEHOLDER,
          name: "orchid-vector",
          model: "example-lab/orchid-1",
          harness: "codex",
        }),
      );
    case "SPONSOR_BOOTSTRAP_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Sponsor bootstrap body is invalid",
        "The signed JSON body is not the strict empty sponsor-bootstrap object.",
        "Send exactly `{}` and sign those two bytes with the sponsor service envelope.",
        enrollmentContractFields({}),
      );
    case "CREDENTIAL_REVOKE_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Credential revoke body is invalid",
        "The signed JSON body does not match the individual credential-revocation contract.",
        "Send the non-secret Fellow and credential ids, the exact confirmation, and the server-stamped recent-auth time.",
        enrollmentContractFields({
          fellow_id: "F-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
          credential_id: "cred-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
          confirm: "revoke-credential",
          step_up_authenticated_at: 1_786_800_000,
        }),
      );
    case "FELLOW_LIFECYCLE_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Fellow lifecycle body is invalid",
        "The signed JSON body does not match the Fellow lifecycle contract.",
        "Send the non-secret Fellow id, one documented target status, the exact confirmation, and the server-stamped recent-auth time.",
        enrollmentContractFields({
          fellow_id: "F-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
          status: "paused",
          confirm: "change-fellow-lifecycle",
          step_up_authenticated_at: 1_786_800_000,
        }),
      );
    case "SPONSOR_PANIC_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Sponsor panic body is invalid",
        "The signed JSON body does not match the sponsor-wide panic contract.",
        "Send the exact destructive confirmation and the server-stamped recent-auth time.",
        enrollmentContractFields({
          confirm: "revoke-all-fellow-credentials",
          step_up_authenticated_at: 1_786_800_000,
        }),
      );
    case "OPERATOR_FELLOW_CAP_BODY_INVALID":
      return problem(
        422,
        error.code,
        "Operator Fellow-cap command body is invalid",
        "The signed JSON body does not match the compare-and-set Fellow-cap override contract.",
        "Send the target sponsor, its currently observed cap, the replacement cap, a durable reason, the exact confirmation, and server-stamped recent-auth time.",
        enrollmentContractFields({
          sponsor_id: "usr_operator_cap_target",
          expected_active_fellow_limit: 5,
          expected_sponsor_seq: 0,
          active_fellow_limit: 6,
          reason: "Reviewed capacity need for active Fellows.",
          confirm: "override-fellow-cap",
          step_up_authenticated_at: 1_786_800_000,
        }),
      );
    case "OPERATOR_FELLOW_CAP_HISTORY_CURSOR_INVALID":
      return problem(
        422,
        error.code,
        "Operator Fellow-cap audit cursor is invalid",
        "The audit-history page cursor is not a canonical cursor from this sponsor's cap history.",
        "Start at the operator audit-history route, then follow next_cursor exactly as a path segment.",
        enrollmentContractFields({
          method: "GET",
          path: "/v1/operators/sponsors/usr_operator_cap_target/fellow-cap/history/after/oc1.<cursor>",
        }),
      );
    case "STEP_UP_REQUIRED":
      return problem(
        403,
        error.code,
        "Recent authentication is required",
        "This sensitive sponsor action does not carry current step-up evidence.",
        "Reauthenticate in the Agora, then retry the exact action.",
      );
    case "FELLOW_LIFECYCLE_NOT_CURRENT":
      return problem(
        404,
        error.code,
        "Lifecycle target is unavailable",
        "No current sponsor-owned lifecycle target can accept this action.",
        "Refresh the sponsor console and act only on the current lifecycle state shown there.",
      );
    case "FELLOW_CAP_REACHED":
      return problem(
        409,
        error.code,
        "Sponsor Fellow capacity is reached",
        "This sponsor cannot activate another Fellow at its current capacity.",
        "Pause or retire an existing Fellow, or ask the operator to raise this sponsor's limit, then retry the exact action.",
      );
    // Distinct from the sponsor-attention cap above: this one bounds how many
    // live credentials a single Fellow may hold. The wording names capacity
    // only — never a credential id, hash, count or expiry — because the
    // sponsor can already enumerate its own Fellow's credentials through the
    // console, and a refusal must not become a second, cheaper inventory.
    case "FELLOW_CREDENTIAL_CAP_REACHED":
      return problem(
        409,
        error.code,
        "Fellow credential capacity is reached",
        "This Fellow already holds the most active credentials it may hold.",
        "Revoke an active credential from your console's Fellows list, then retry the exact request with a new Idempotency-Key.",
      );
    case "OPERATOR_FELLOW_CAP_NOT_CURRENT":
      return problem(
        409,
        error.code,
        "Fellow-cap command is no longer current",
        "The requested Fellow-cap transition was not accepted.",
        "Refresh the operator record and submit a new signed command with its current precondition and a new Idempotency-Key.",
      );
    case "SPONSOR_ENROLLMENT_RATE_LIMITED": {
      const response = problem(
        429,
        error.code,
        "Sponsor enrollment starts are temporarily limited",
        "This sponsor cannot start another enrollment during the current rolling day.",
        "Wait before starting another enrollment. If this was a device flow, begin a fresh device enrollment after the retry window.",
      );
      // The authenticated sponsor may see its own coarse current budget, but
      // not the timing or identity of any contributing attempt.
      const retryAfterSeconds =
        error instanceof SponsorEnrollmentRateLimitError
          ? error.retryAfterSeconds
          : SPONSOR_ENROLLMENT_RATE_LIMIT_WINDOW_MS / 1_000 + 1;
      response.headers.set("retry-after", String(retryAfterSeconds));
      response.headers.set("ratelimit-limit", String(SPONSOR_ENROLLMENT_RATE_LIMIT_ATTEMPTS));
      response.headers.set("ratelimit-remaining", "0");
      response.headers.set("ratelimit-reset", String(retryAfterSeconds));
      return response;
    }
    case "LIFECYCLE_BUSY": {
      const response = problem(
        429,
        error.code,
        "Another sponsor lifecycle action is committing",
        "A sensitive action for this sponsor is already being committed.",
        "Retry this exact body with the same Idempotency-Key after one second.",
      );
      response.headers.set("retry-after", "1");
      return response;
    }
    case "DEVICE_CODE_UNKNOWN":
      return problem(
        404,
        "DEVICE_CODE_UNKNOWN",
        "No pending proposal for that code",
        "No pending device proposal matches that user code.",
        "Check the code with the agent's operator. Codes expire thirty minutes after they are shown.",
      );
    case "DEVICE_LOOKUP_LOCKED": {
      const response = problem(
        429,
        "DEVICE_LOOKUP_LOCKED",
        "Too many failed code attempts",
        "Several recent user-code lookups failed, so code entry is locked for a while.",
        "Wait at least fifteen minutes and one second before trying another code.",
      );
      response.headers.set("retry-after", "901");
      return response;
    }
    case "DEVICE_START_RATE_LIMITED": {
      const response = problem(
        429,
        "DEVICE_START_RATE_LIMITED",
        "Device enrollment is temporarily limited",
        "This source cannot start another device enrollment right now.",
        "Wait before starting another device enrollment. An existing flow may still be polled.",
      );
      // A fixed coarse retry hint helps a well-behaved client without exposing
      // the bucket threshold or the precise age of another attempt.
      response.headers.set("retry-after", "901");
      return response;
    }
    case "IDEMPOTENCY_CONFLICT":
      return problem(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key does not match this request",
        "This key was already used for a different write request.",
        "Reuse the original request body with this key or choose a new key for a new operation.",
        enrollmentContractFields(idempotencyConflictExample(request)),
      );
    case "SCOPE_ESCALATION":
      return problem(
        422,
        error.code,
        "Grant reduction cannot increase access",
        "The requested reduction includes a scope or resource beyond the pending proposal.",
        "Choose only a strict subset of the scopes and resources shown on the pending approval card.",
        {
          rule: "ADR-20",
          schema: ENROLLMENT_SCHEMA_URL,
          example: {
            enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
            decision: "reduce",
            reduction: { scopes: ["review"] },
            step_up_authenticated_at: 1_786_800_000,
          },
        },
      );
    case "SCOPE_NOT_REDUCED":
      return problem(
        422,
        error.code,
        "Grant reduction must be strictly narrower",
        "The requested reduction leaves the pending grant unchanged.",
        "Remove at least one scope or resource, or lower a numeric budget or expiry below the pending value.",
        {
          rule: "ADR-20",
          schema: ENROLLMENT_SCHEMA_URL,
          example: {
            enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
            decision: "reduce",
            reduction: { scopes: ["review"] },
            step_up_authenticated_at: 1_786_800_000,
          },
        },
      );
    case "FLOW_INVALID":
    case "TOKEN_ALREADY_ISSUED":
      return problem(
        400,
        "FLOW_INVALID",
        "Enrollment flow cannot be used",
        "The flow credential was not accepted.",
        "Use the high-entropy flow handle only in the JSON request body. An issued token is not re-shown on a plain retry; if the issuing poll carried an Idempotency-Key, re-poll with the same key and body within 24 hours to replay its exact response.",
      );
    default:
      // Pairing/secret failures intentionally reveal neither which field failed
      // nor whether an enrollment id exists.
      return problem(
        400,
        "PAIRING_INVALID",
        "Enrollment request cannot be accepted",
        "The enrollment request was not accepted.",
        "Read the fragment secret locally and submit the documented JSON body once.",
      );
  }
}

function enrollmentOperationalFailure(error: unknown): Response | undefined {
  if (
    !(error instanceof EnrollmentPersistenceError) &&
    !(error instanceof EnrollmentReplayConfigurationError)
  ) {
    return undefined;
  }
  return enrollmentUnavailableResponse();
}

function enrollmentUnavailableResponse(): Response {
  return problem(
    503,
    "ENROLLMENT_UNAVAILABLE",
    "Enrollment is temporarily unavailable",
    "The enrollment service could not complete this request safely.",
    "Retry later. For an authority-producing write, reuse its required original Idempotency-Key. Retry a read-only request normally.",
  );
}

function capsuleUnavailableResponse(): Response {
  return problem(
    404,
    "CAPSULE_UNAVAILABLE",
    "Enrollment capsule is unavailable",
    "This enrollment capsule is unavailable.",
    "Check the public enrollment id and obtain a fresh sponsor-issued join URL if needed.",
  );
}

function decisionBodyInvalidResponse(): Response {
  return problem(
    422,
    "DECISION_BODY_INVALID",
    "Sponsor decision body is invalid",
    "The signed JSON body does not match the sponsor decision contract.",
    "Send a strict approve, deny, or reduce command with the enrollment id named by the request path and Agora's server-stamped recent-auth time, then sign those exact bytes.",
    {
      rule: "ADR-20",
      schema: ENROLLMENT_SCHEMA_URL,
      example: {
        method: "POST",
        path: "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "decision-01JXYZ4K6Q",
        },
        body: {
          enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
          decision: "approve",
          step_up_authenticated_at: 1_786_800_000,
        },
      },
    },
  );
}

function enrollmentIdInvalidResponse(): Response {
  return problem(
    422,
    "ENROLLMENT_ID_INVALID",
    "Enrollment id is invalid",
    "The decision path does not contain a syntactically valid public enrollment id.",
    "Use the enrollment id from a pending approval card in both the request path and the signed decision body.",
    enrollmentContractFields({
      method: "POST",
      path: "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "decision-01JXYZ4K6Q",
      },
      body: {
        enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
        decision: "approve",
        step_up_authenticated_at: 1_786_800_000,
      },
    }),
  );
}

function mintBodyInvalidResponse(): Response {
  return problem(
    422,
    "MINT_BODY_INVALID",
    "Sponsor mint body is invalid",
    "The signed JSON body does not match the enrollment mint contract.",
    "Send a strict JSON object with the requested scopes, then sign those exact bytes.",
    enrollmentContractFields({
      method: "POST",
      path: "/v1/enrollments",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "mint-01JXYZ4K6Q",
      },
      body: { requested_scopes: ["promote"] },
    }),
  );
}

function sponsorPathOnlyResponse(request: Request, path: string): Response {
  return problem(
    400,
    "PATH_ONLY_REQUIRED",
    "Sponsor request target is path-only",
    "URL query parameters are outside the signed sponsor-route contract and are not accepted.",
    "Remove the query string; for writes, put typed fields in the exact JSON body that the service envelope signs.",
    enrollmentContractFields({ method: request.method, path, query: "none" }),
  );
}

function fellowListCursorInvalidResponse(): Response {
  return problem(
    422,
    "FELLOW_LIST_CURSOR_INVALID",
    "Fellow list cursor is invalid",
    "The Fellow page cursor is not a canonical cursor from this inventory.",
    "Start at GET /v1/fellows, then follow the next_cursor exactly as a path segment.",
    enrollmentContractFields({
      method: "GET",
      path: "/v1/fellows/after/f1.djF8MTM6MTc4NjgwMDAwMDAwMHwxMzpmZWxsb3ctMDFKWFla",
      query: "none",
    }),
  );
}

async function jsonBody(
  request: Request,
  invalidCode: EnrollmentErrorCode = "PAIRING_INVALID",
): Promise<unknown> {
  const body = await readBoundedRequestBody(request, MAX_ENROLLMENT_REQUEST_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === "too-large") throw new EnrollmentRequestBodyTooLargeError();
    throw new EnrollmentError(invalidCode);
  }
  try {
    return parseExactJsonBytes(body.bytes);
  } catch {
    throw new EnrollmentError(invalidCode);
  }
}

function enrollmentRequestIngressFailure(error: unknown): Response | undefined {
  if (!(error instanceof EnrollmentRequestBodyTooLargeError)) return undefined;
  return problem(
    413,
    "REQUEST_BODY_TOO_LARGE",
    "Enrollment request body is too large",
    "The enrollment request exceeds the byte ceiling for this route.",
    "Send only the documented JSON fields within the request-body limit.",
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  // Bound before hashing: bearer input is untrusted header data and a large
  // value must not create avoidable hashing work or a diagnostic surface.
  const match = /^([A-Za-z]+) +(asimp_ag_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43})$/.exec(
    authorization,
  );
  return match?.[1]?.toLowerCase() === "bearer" ? match[2] : undefined;
}

function idempotencyOptions(request: Request): { readonly idempotencyKey: string } | Response {
  const key = request.headers.get("idempotency-key");
  if (key === null || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
    return problem(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key is required and must be valid",
      "A successful write may have a response that must be replayed exactly, so it requires a stable replay key.",
      "Send 1 to 160 letters, digits, dots, underscores, or hyphens and reuse the same key for an unchanged retry.",
      enrollmentContractFields(idempotencyHeaderExample(request)),
    );
  }
  return { idempotencyKey: key };
}

/**
 * Cloudflare overwrites CF-Connecting-IP on the proxied Worker boundary. No
 * caller-supplied forwarding chain is consulted. Strict shape validation keeps
 * direct/local requests from inventing arbitrary bucket strings; absence is an
 * operational refusal rather than an unbounded shared fallback.
 */
function trustedDeviceClientAddress(request: Request): string | undefined {
  const value = request.headers.get("cf-connecting-ip");
  if (value === null || value !== value.trim() || value.length < 2 || value.length > 45) {
    return undefined;
  }
  if (value.includes(":")) {
    if (!/^[0-9A-Fa-f:.]+$/.test(value)) return undefined;
    try {
      const hostname = new URL(`http://[${value}]/`).hostname;
      if (!hostname.startsWith("[") || !hostname.endsWith("]")) return undefined;
      return hostname.slice(1, -1).toLowerCase();
    } catch {
      return undefined;
    }
  }
  const segments = value.split(".");
  if (
    segments.length !== 4 ||
    segments.some(
      (segment) => !/^(?:0|[1-9][0-9]{0,2})$/.test(segment) || Number.parseInt(segment, 10) > 255,
    )
  ) {
    return undefined;
  }
  return segments.join(".");
}

/**
 * Mountable Propylon S-1 sub-app. The shared Worker app owns authentication
 * middleware and chooses where to mount it; this module owns only typed
 * enrollment routes and never modifies the shared router.
 */
export function createEnrollmentRouter(options: EnrollmentRouterOptions): Hono {
  const app = new Hono();

  app.get("/join/:enrollmentId", async (c) => {
    if (hasQuery(c.req.raw)) {
      return problem(
        400,
        "PATH_ONLY_REQUIRED",
        "Enrollment capsule is path-only",
        "This public capsule accepts its enrollment id only as a path component.",
        "Remove query parameters and keep the join secret in the URL fragment.",
        enrollmentContractFields({
          method: "GET",
          path: "/join/ASIMP-EN-01JXYZ4K6Q",
          secret_transport: "URL fragment only; never sent with this request",
        }),
      );
    }
    const enrollmentId = c.req.param("enrollmentId");
    if (!EnrollmentIdSchema.safeParse(enrollmentId).success) {
      return capsuleUnavailableResponse();
    }
    try {
      const projection = enrollmentCapsuleProjection(
        await options.service.capsule(enrollmentId),
        options.service.stoaOrigin,
      );
      const face = selectCapsuleFace(c.req.header("accept") ?? "");
      const body =
        face === "json"
          ? JSON.stringify(projection)
          : face === "html"
            ? enrollmentCapsuleHtml(projection)
            : enrollmentCapsuleMarkdown(projection);
      const etag = await strongEtag(face, body);
      const headers = {
        // The capsule path is public and contains no fragment secret. Allow a
        // cache to retain the face, but require revalidation every time so a
        // consumed, expired, or superseded capsule becomes its opaque 404
        // immediately and the ETag/304 contract remains usable.
        "cache-control": "no-cache",
        etag,
        vary: "Accept",
        "content-type":
          face === "json"
            ? "application/json; charset=utf-8"
            : face === "html"
              ? "text/html; charset=UTF-8"
              : "text/markdown; charset=utf-8",
      };
      if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
        return c.body(null, 304, headers);
      }
      return c.body(body, 200, headers);
    } catch (error) {
      // A public join path may be malformed or may refer to an enrollment that
      // was never minted, expired, superseded, or consumed. Those absences are
      // intentionally one 404 face; no state distinction is public. A plain
      // service or schema failure is operational instead, never a false 404.
      return error instanceof EnrollmentError
        ? capsuleUnavailableResponse()
        : enrollmentUnavailableResponse();
    }
  });

  // W3.5: the one open write on the surface. An unaffiliated agent starts the
  // proposal-carrying device flow here; it has no credential yet by
  // construction. The Cloudflare-authenticated source bucket is reserved in
  // the same D1 transaction as the proposal; the raw address is never stored.
  app.post("/v1/device-code", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Device flow fields are body-only",
        "Device flow fields are not accepted in a URL query string.",
        "Send the documented JSON body without query parameters.",
        enrollmentContractFields({
          method: "POST",
          path: "/v1/device-code",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "enrollment-01JXYZ4K6Q",
          },
          body: {
            name: "orchid-vector",
            model: "example-lab/orchid-1",
            harness: "codex",
            requested_scopes: ["review"],
          },
        }),
      );
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse(
        "/v1/device-code",
        {
          name: "orchid-vector",
          model: "example-lab/orchid-1",
          harness: "codex",
          requested_scopes: ["review"],
        },
        true,
      );
    }
    const trustedClientAddress = trustedDeviceClientAddress(c.req.raw);
    if (trustedClientAddress === undefined) {
      cancelUnconsumedRequestBody(c.req.raw);
      return enrollmentUnavailableResponse();
    }
    const idempotency = idempotencyOptions(c.req.raw);
    if (idempotency instanceof Response) {
      cancelUnconsumedRequestBody(c.req.raw);
      return idempotency;
    }
    try {
      const started = await options.service.deviceStart(
        await jsonBody(c.req.raw, "DEVICE_CODE_BODY_INVALID"),
        { ...idempotency, trustedClientAddress },
      );
      return c.json(DeviceCodeStartResponseSchema.parse(started), 201, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const ingress = enrollmentRequestIngressFailure(error);
      if (ingress !== undefined) return ingress;
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/fellows", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Enrollment credentials are body-only",
        "Enrollment credentials are not accepted in a URL query string.",
        "Send the documented JSON body without query parameters.",
        enrollmentContractFields({
          method: "POST",
          path: "/v1/fellows",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "enrollment-01JXYZ4K6Q",
          },
          body: {
            enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
            secret: FRAGMENT_VALUE_PLACEHOLDER,
            name: "orchid-vector",
            model: "example-lab/orchid-1",
            harness: "codex",
          },
        }),
      );
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse(
        "/v1/fellows",
        {
          enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
          secret: FRAGMENT_VALUE_PLACEHOLDER,
          name: "orchid-vector",
          model: "example-lab/orchid-1",
          harness: "codex",
        },
        true,
      );
    }
    try {
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) {
        cancelUnconsumedRequestBody(c.req.raw);
        return idempotency;
      }
      const claim = await options.service.claim(await jsonBody(c.req.raw), idempotency);
      const result = EnrollmentClaimResponseSchema.parse({
        flow_handle: claim.flowHandle,
      });
      return c.json(result, 202, { "cache-control": "no-store" });
    } catch (error) {
      const ingress = enrollmentRequestIngressFailure(error);
      if (ingress !== undefined) return ingress;
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  const poll = async (
    request: Request,
    route: "/v1/fellows/flow" | "/v1/device-token",
  ): Promise<Response> => {
    if (hasQuery(request)) {
      cancelUnconsumedRequestBody(request);
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Flow credentials are body-only",
        "A flow credential is not accepted in a URL query string.",
        'Send `{ "flow_handle": "…" }` as the JSON request body.',
        enrollmentContractFields({
          method: "POST",
          path: route,
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "enrollment-01JXYZ4K6Q",
          },
          body: { flow_handle: "<flow handle from the claim response>" },
        }),
      );
    }
    if (!hasJsonContentType(request)) {
      cancelUnconsumedRequestBody(request);
      return jsonContentTypeRequiredResponse(
        route,
        {
          flow_handle: "<flow handle from the claim response>",
        },
        true,
      );
    }
    try {
      const idempotency = idempotencyOptions(request);
      if (idempotency instanceof Response) {
        cancelUnconsumedRequestBody(request);
        return idempotency;
      }
      const result = await options.service.poll(await jsonBody(request), idempotency);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const ingress = enrollmentRequestIngressFailure(error);
      if (ingress !== undefined) return ingress;
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, request)
        : enrollmentUnavailableResponse();
    }
  };

  app.post("/v1/fellows/flow", (c) => poll(c.req.raw, "/v1/fellows/flow"));
  app.post("/v1/device-token", (c) => poll(c.req.raw, "/v1/device-token"));

  app.get("/v1/hello", async (c) => {
    if (hasQuery(c.req.raw)) {
      return problem(
        400,
        "BODY_ONLY_REQUIRED",
        "Bearer token is header-only",
        "A Fellow bearer token is not accepted in a URL query string.",
        "Use an Authorization header with a valid one-time Fellow token.",
        enrollmentContractFields({
          method: "GET",
          path: "/v1/hello",
          headers: { Authorization: "Bearer <approved Fellow token>" },
        }),
      );
    }
    try {
      const token = bearerToken(c.req.raw);
      const binding =
        token === undefined ? undefined : await options.service.credentialBinding(token);
      if (binding === undefined) {
        return problem(
          401,
          "FELLOW_TOKEN_INVALID",
          "Fellow bearer token is not accepted",
          "The bearer token was not accepted.",
          "Obtain a token through an explicitly approved enrollment flow and send it in Authorization.",
        );
      }
      const response = EnrollmentHelloResponseSchema.parse({
        fellow: {
          fellow_id: binding.fellowId,
          name: binding.name,
          model: binding.model,
          harness: binding.harness,
        },
        granted_scopes: binding.grantedScopes,
        granted_resources: {
          ...(binding.grantedResources.problemBinding === undefined
            ? {}
            : { problem_binding: binding.grantedResources.problemBinding }),
          ...(binding.grantedResources.firstDirective === undefined
            ? {}
            : { first_directive: binding.grantedResources.firstDirective }),
          ...(binding.grantedResources.eventBudget === undefined
            ? {}
            : { event_budget: binding.grantedResources.eventBudget }),
          ...(binding.grantedResources.artifactBudgetBytes === undefined
            ? {}
            : {
                artifact_budget_bytes: binding.grantedResources.artifactBudgetBytes,
              }),
          ...(binding.grantedResources.fellowGrantExpiresAt === undefined
            ? {}
            : {
                fellow_grant_expires_at: binding.grantedResources.fellowGrantExpiresAt,
              }),
        },
        next_actions: [
          {
            action: "read",
            url: `${options.service.stoaOrigin}/protocol.md`,
            reason:
              "The rules and the whole bar for promoting; read once before your first promotion.",
          },
          {
            action: "read",
            url: `${options.service.stoaOrigin}/skill.md`,
            reason:
              "The participation skill: polling discipline, the idempotency-key recovery rule, and the reference map.",
          },
        ],
      });
      return c.json(response, 200, { "cache-control": "no-store" });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      return operational ?? enrollmentUnavailableResponse();
    }
  });

  mountSponsorRoutes(app, options);

  return app;
}

/**
 * A verifier can supply its own typed refusal. It is still a private response:
 * preserve its exact body and metadata while forbidding shared or client cache
 * retention at the enrollment-router boundary.
 */
function privateNoStoreVerifierRefusal(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The sponsor's service-envelope identity, or the exact refusal to serve. */
async function requireSponsor(
  options: EnrollmentRouterOptions,
  request: Request,
  route: string,
  action: string,
): Promise<{ readonly principal: EnrollmentPrincipal; readonly rawBody: Uint8Array } | Response> {
  if (options.verifiedSponsor === undefined) {
    cancelUnconsumedRequestBody(request);
    return sponsorAuthUnavailableResponse();
  }
  try {
    const result = await options.verifiedSponsor(request, route, action);
    if (result instanceof Response) {
      cancelUnconsumedRequestBody(request);
      return privateNoStoreVerifierRefusal(result);
    }
    if (
      !isEnrollmentPrincipal(result?.principal) ||
      result.principal.type !== "sponsor" ||
      !SponsorIdSchema.safeParse(result.principal.sponsorId).success ||
      !(result?.rawBody instanceof Uint8Array)
    ) {
      cancelUnconsumedRequestBody(request);
      return sponsorAuthUnavailableResponse();
    }
    // From here on handlers consume only the authenticated raw bytes. A custom
    // verifier that supplied those bytes without draining Fetch still leaves
    // the original stream under this router's ownership.
    cancelUnconsumedRequestBody(request);
    return result;
  } catch {
    cancelUnconsumedRequestBody(request);
    return sponsorAuthUnavailableResponse();
  }
}

/** The allowlisted operator's service-envelope identity, or a typed safe refusal. */
async function requireOperator(
  options: EnrollmentRouterOptions,
  request: Request,
  route: string,
  action: string,
): Promise<{ readonly principal: EnrollmentPrincipal; readonly rawBody: Uint8Array } | Response> {
  if (options.verifiedOperator === undefined) {
    cancelUnconsumedRequestBody(request);
    return operatorAuthUnavailableResponse();
  }
  try {
    const result = await options.verifiedOperator(request, route, action);
    if (result instanceof Response) {
      cancelUnconsumedRequestBody(request);
      return privateNoStoreVerifierRefusal(result);
    }
    if (
      !isEnrollmentPrincipal(result?.principal) ||
      result.principal.type !== "operator" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(result.principal.serviceEnvelopeKid) ||
      !(result?.rawBody instanceof Uint8Array)
    ) {
      cancelUnconsumedRequestBody(request);
      return operatorAuthUnavailableResponse();
    }
    cancelUnconsumedRequestBody(request);
    return result;
  } catch {
    cancelUnconsumedRequestBody(request);
    return operatorAuthUnavailableResponse();
  }
}

function sponsorAuthUnavailableResponse(): Response {
  return problem(
    503,
    "SPONSOR_AUTH_UNAVAILABLE",
    "Sponsor authentication is temporarily unavailable",
    "The Worker could not verify this sponsor request safely.",
    "Retry later. If the failure persists, check the service-envelope keyring and nonce store before re-signing the request.",
  );
}

function operatorAuthUnavailableResponse(): Response {
  return problem(
    503,
    "OPERATOR_AUTH_UNAVAILABLE",
    "Operator writes are not configured on this Worker",
    "This deployment cannot verify operator authorization safely.",
    "Configure the service-envelope verification keys and operator allowlist, then retry.",
  );
}

function isEnrollmentPrincipal(value: unknown): value is EnrollmentPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const principal = value as Record<string, unknown>;
  switch (principal.type) {
    case "sponsor":
      return typeof principal.sponsorId === "string" && principal.sponsorId.length > 0;
    case "operator":
      return (
        typeof principal.operatorId === "string" &&
        principal.operatorId.length > 0 &&
        typeof principal.serviceEnvelopeKid === "string" &&
        principal.serviceEnvelopeKid.length > 0
      );
    case "fellow":
      return typeof principal.fellowId === "string" && principal.fellowId.length > 0;
    case "service":
      return typeof principal.serviceId === "string" && principal.serviceId.length > 0;
    default:
      return false;
  }
}

/** Internal camelCase grants to the contract's snake_case resources object. */
function contractResources(grants: EnrollmentResourceGrants): Record<string, unknown> {
  return {
    ...(grants.problemBinding === undefined ? {} : { problem_binding: grants.problemBinding }),
    ...(grants.firstDirective === undefined ? {} : { first_directive: grants.firstDirective }),
    ...(grants.eventBudget === undefined ? {} : { event_budget: grants.eventBudget }),
    ...(grants.artifactBudgetBytes === undefined
      ? {}
      : { artifact_budget_bytes: grants.artifactBudgetBytes }),
    ...(grants.fellowGrantExpiresAt === undefined
      ? {}
      : { fellow_grant_expires_at: grants.fellowGrantExpiresAt }),
  };
}

function contractCard(card: {
  enrollmentId: string;
  proposalId: string;
  status: "pending" | "approved" | "reduced" | "denied" | "expired";
  name: string;
  model: string;
  harness: string;
  reasoningEffort?: string;
  toolsNote?: string;
  requestedScopes: readonly ("promote" | "review" | "propose-problems" | "upload-artifacts")[];
  requestedResources: EnrollmentResourceGrants;
  effectiveGrantedScopes:
    | readonly ("promote" | "review" | "propose-problems" | "upload-artifacts")[]
    | null;
  effectiveGrantedResources: EnrollmentResourceGrants | null;
  proposalExpiresAt: number;
}): Record<string, unknown> {
  return {
    enrollment_id: card.enrollmentId,
    proposal_id: card.proposalId,
    status: card.status,
    name: card.name,
    model: card.model,
    harness: card.harness,
    ...(card.reasoningEffort === undefined ? {} : { reasoning_effort: card.reasoningEffort }),
    ...(card.toolsNote === undefined ? {} : { tools_note: card.toolsNote }),
    requested_scopes: card.requestedScopes,
    requested_resources: contractResources(card.requestedResources),
    effective_granted_scopes: card.effectiveGrantedScopes,
    effective_granted_resources:
      card.effectiveGrantedResources === null
        ? null
        : contractResources(card.effectiveGrantedResources),
    proposal_expires_at: card.proposalExpiresAt,
  };
}

function contractFellow(record: SponsorFellowRecord): Record<string, unknown> {
  return {
    fellow_id: record.fellowId,
    name: record.name,
    model: record.model,
    harness: record.harness,
    status: record.status,
    granted_scopes: record.grantedScopes,
    granted_resources: contractResources(record.grantedResources),
    granted_at: record.grantedAt,
    credentials: record.credentials.map((credential) => ({
      credential_id: credential.credentialId,
      profile: credential.profile,
      issued_at: credential.issuedAt,
      expires_at: credential.expiresAt,
      last_used_at: credential.lastUsedAt ?? null,
      active: credential.active,
    })),
  };
}

/**
 * The sponsor half of Propylon (W3.3/W3.4): mint, the approval card list, the
 * decision write, and the Fellows list. Every route runs through the parent's
 * envelope seam; a Fellow bearer is refused before the handler runs.
 */
function mountSponsorRoutes(app: Hono, options: EnrollmentRouterOptions): void {
  app.get("/v1/operators/sponsors/:sponsorId/fellow-cap", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(
        c.req.raw,
        "/v1/operators/sponsors/usr_operator_cap_target/fellow-cap",
      );
    }
    const sponsorId = c.req.param("sponsorId");
    if (!SponsorIdSchema.safeParse(sponsorId).success) {
      return enrollmentErrorResponse(
        new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT"),
        c.req.raw,
      );
    }
    const authenticated = await requireOperator(
      options,
      c.req.raw,
      "/v1/operators/sponsors/:sponsorId/fellow-cap",
      "operator.fellow-cap.read",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const state = await options.service.operatorFellowCapState(
        authenticated.principal,
        sponsorId,
      );
      return c.json(
        OperatorFellowCapStateResponseSchema.parse({
          sponsor_id: state.sponsorId,
          active_fellow_limit: state.activeFellowLimit,
          sponsor_seq: state.sponsorSeq,
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.get("/v1/operators/sponsors/:sponsorId/fellow-cap/history", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(
        c.req.raw,
        "/v1/operators/sponsors/usr_operator_cap_target/fellow-cap/history",
      );
    }
    const sponsorId = c.req.param("sponsorId");
    if (!SponsorIdSchema.safeParse(sponsorId).success) {
      return enrollmentErrorResponse(
        new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT"),
        c.req.raw,
      );
    }
    const authenticated = await requireOperator(
      options,
      c.req.raw,
      "/v1/operators/sponsors/:sponsorId/fellow-cap/history",
      "operator.fellow-cap.history",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const page = await options.service.operatorFellowCapAuditPage(
        authenticated.principal,
        sponsorId,
      );
      return c.json(
        OperatorFellowCapAuditPageResponseSchema.parse({
          audit_events: page.auditEvents.map((event) => ({
            audit_event_id: event.auditEventId,
            sponsor_id: event.sponsorId,
            operator_id: event.operatorId,
            sponsor_seq: event.sponsorSeq,
            previous_active_fellow_limit: event.previousActiveFellowLimit,
            active_fellow_limit: event.activeFellowLimit,
            reason: event.reason,
            step_up_authenticated_at: event.stepUpAuthenticatedAt,
            signer_kid: event.signerKid,
            effective_at: event.effectiveAt,
          })),
          next_cursor:
            page.nextCursor === undefined
              ? null
              : encodeOperatorFellowCapAuditCursor(page.nextCursor),
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.get("/v1/operators/sponsors/:sponsorId/fellow-cap/history/after/:cursor", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(
        c.req.raw,
        "/v1/operators/sponsors/usr_operator_cap_target/fellow-cap/history/after/<cursor>",
      );
    }
    const sponsorId = c.req.param("sponsorId");
    if (!SponsorIdSchema.safeParse(sponsorId).success) {
      return enrollmentErrorResponse(
        new EnrollmentError("OPERATOR_FELLOW_CAP_NOT_CURRENT"),
        c.req.raw,
      );
    }
    const after = parseOperatorFellowCapAuditCursor(c.req.param("cursor"));
    if (after === undefined) {
      return enrollmentErrorResponse(
        new EnrollmentError("OPERATOR_FELLOW_CAP_HISTORY_CURSOR_INVALID"),
        c.req.raw,
      );
    }
    const authenticated = await requireOperator(
      options,
      c.req.raw,
      "/v1/operators/sponsors/:sponsorId/fellow-cap/history/after/:cursor",
      "operator.fellow-cap.history",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const page = await options.service.operatorFellowCapAuditPage(
        authenticated.principal,
        sponsorId,
        after,
      );
      return c.json(
        OperatorFellowCapAuditPageResponseSchema.parse({
          audit_events: page.auditEvents.map((event) => ({
            audit_event_id: event.auditEventId,
            sponsor_id: event.sponsorId,
            operator_id: event.operatorId,
            sponsor_seq: event.sponsorSeq,
            previous_active_fellow_limit: event.previousActiveFellowLimit,
            active_fellow_limit: event.activeFellowLimit,
            reason: event.reason,
            step_up_authenticated_at: event.stepUpAuthenticatedAt,
            signer_kid: event.signerKid,
            effective_at: event.effectiveAt,
          })),
          next_cursor:
            page.nextCursor === undefined
              ? null
              : encodeOperatorFellowCapAuditCursor(page.nextCursor),
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/operators/fellow-cap", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/operators/fellow-cap");
    }
    const example = {
      sponsor_id: "usr_operator_cap_target",
      expected_active_fellow_limit: 5,
      expected_sponsor_seq: 0,
      active_fellow_limit: 6,
      reason: "Reviewed capacity need for active Fellows.",
      confirm: "override-fellow-cap",
      step_up_authenticated_at: 1_786_800_000,
    };
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/operators/fellow-cap", example, true);
    }
    const authenticated = await requireOperator(
      options,
      c.req.raw,
      "/v1/operators/fellow-cap",
      "operator.fellow-cap.override",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let body: unknown;
      try {
        body = verifiedJson(authenticated.rawBody);
      } catch {
        return enrollmentErrorResponse(
          new EnrollmentError("OPERATOR_FELLOW_CAP_BODY_INVALID"),
          c.req.raw,
        );
      }
      const parsed = OperatorFellowCapOverrideRequestSchema.safeParse(body);
      if (!parsed.success) {
        return enrollmentErrorResponse(
          new EnrollmentError("OPERATOR_FELLOW_CAP_BODY_INVALID"),
          c.req.raw,
        );
      }
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      const response = await options.service.overrideSponsorFellowCap(
        authenticated.principal,
        parsed.data,
        idempotency,
      );
      return c.json(OperatorFellowCapOverrideResponseSchema.parse(response), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/enrollments", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/enrollments");
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse(
        "/v1/enrollments",
        {
          requested_scopes: ["promote"],
        },
        true,
      );
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/enrollments",
      "enrollment.mint",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      let mintBody: unknown;
      try {
        mintBody = verifiedJson(authenticated.rawBody);
      } catch {
        return mintBodyInvalidResponse();
      }
      const parsed = MintEnrollmentRequestSchema.safeParse(mintBody);
      if (!parsed.success) return mintBodyInvalidResponse();
      const minted = await options.service.mint(authenticated.principal, parsed.data, idempotency);
      const response = MintEnrollmentResponseSchema.parse({
        enrollment_id: minted.enrollmentId,
        join_url: stoaJoinUrl(options.service.stoaOrigin, minted.enrollmentId, minted.secret),
        secret: minted.secret,
        expires_at: minted.expiresAt,
      });
      // The one time the fragment secret ever crosses a response body: TLS, to
      // the authenticated sponsor, never logged (Fable §14.3 never-log list).
      return c.json(response, 201, { "cache-control": "no-store" });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.get("/v1/enrollments/proposals", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(c.req.raw, "/v1/enrollments/proposals");
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/enrollments/proposals",
      "enrollment.proposals.list",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const cards = await options.service.pendingApprovals(authenticated.principal);
      return c.json(
        SponsorProposalListResponseSchema.parse({
          proposals: cards.map(contractCard),
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/enrollments/:enrollmentId/decision", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision");
    }
    const enrollmentId = c.req.param("enrollmentId");
    if (!EnrollmentIdSchema.safeParse(enrollmentId).success) {
      cancelUnconsumedRequestBody(c.req.raw);
      return enrollmentIdInvalidResponse();
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse(
        "/v1/enrollments/ASIMP-EN-01JXYZ4K6Q/decision",
        {
          enrollment_id: "ASIMP-EN-01JXYZ4K6Q",
          decision: "approve",
          step_up_authenticated_at: 1_786_800_000,
        },
        true,
      );
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/enrollments/:enrollmentId/decision",
      "enrollment.decide",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let decisionBody: unknown;
      try {
        decisionBody = verifiedJson(authenticated.rawBody);
      } catch {
        return decisionBodyInvalidResponse();
      }
      const parsed = SponsorEnrollmentDecisionCommandSchema.safeParse(decisionBody);
      if (!parsed.success) {
        return decisionBodyInvalidResponse();
      }
      // The envelope signs the body digest and the route *template*, never the
      // filled path, so this equality is what binds an approve to the proposal
      // it was authored for. Authentication has already consumed the service-
      // envelope nonce; this later check runs before the product idempotency
      // key is read and before any enrollment-store call, so a retargeted
      // decision creates no product replay row and reaches no proposal. Both
      // sides are caller-supplied, so comparing them discloses nothing about
      // either enrollment's existence.
      if (parsed.data.enrollment_id !== enrollmentId) {
        return enrollmentErrorResponse(new EnrollmentError("DECISION_TARGET_MISMATCH"), c.req.raw);
      }
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      await options.service.decide(authenticated.principal, enrollmentId, parsed.data, idempotency);
      return c.json(SponsorEnrollmentDecisionResponseSchema.parse({ acknowledged: true }), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.get("/v1/fellows", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(c.req.raw, "/v1/fellows");
    }
    const authenticated = await requireSponsor(options, c.req.raw, "/v1/fellows", "fellows.list");
    if (authenticated instanceof Response) return authenticated;
    try {
      const page = await options.service.fellowPage(authenticated.principal);
      return c.json(
        SponsorFellowListResponseSchema.parse({
          fellows: page.fellows.map(contractFellow),
          next_cursor:
            page.nextCursor === undefined ? null : encodeSponsorFellowCursor(page.nextCursor),
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.get("/v1/fellows/after/:cursor", async (c) => {
    if (hasQuery(c.req.raw)) {
      return sponsorPathOnlyResponse(c.req.raw, "/v1/fellows/after/<cursor>");
    }
    const after = parseSponsorFellowCursor(c.req.param("cursor"));
    if (after === undefined) return fellowListCursorInvalidResponse();
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/fellows/after/:cursor",
      "fellows.list",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      const page = await options.service.fellowPage(authenticated.principal, after);
      return c.json(
        SponsorFellowListResponseSchema.parse({
          fellows: page.fellows.map(contractFellow),
          next_cursor:
            page.nextCursor === undefined ? null : encodeSponsorFellowCursor(page.nextCursor),
        }),
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/fellows/credentials/revoke", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/fellows/credentials/revoke");
    }
    const example = {
      fellow_id: "F-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
      credential_id: "cred-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
      confirm: "revoke-credential",
      step_up_authenticated_at: 1_786_800_000,
    };
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/fellows/credentials/revoke", example, true);
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/fellows/credentials/revoke",
      "fellow.credential.revoke",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let body: unknown;
      try {
        body = verifiedJson(authenticated.rawBody);
      } catch {
        return enrollmentErrorResponse(
          new EnrollmentError("CREDENTIAL_REVOKE_BODY_INVALID"),
          c.req.raw,
        );
      }
      const parsed = SponsorCredentialRevokeRequestSchema.safeParse(body);
      if (!parsed.success) {
        return enrollmentErrorResponse(
          new EnrollmentError("CREDENTIAL_REVOKE_BODY_INVALID"),
          c.req.raw,
        );
      }
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      const response = await options.service.revokeCredential(
        authenticated.principal,
        parsed.data,
        idempotency,
      );
      return c.json(SponsorCredentialRevokeResponseSchema.parse(response), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/fellows/lifecycle", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/fellows/lifecycle");
    }
    const example = {
      fellow_id: "F-01JXYZ4K6Q8M2N3P4R5S6T7V8W",
      status: "paused",
      confirm: "change-fellow-lifecycle",
      step_up_authenticated_at: 1_786_800_000,
    };
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/fellows/lifecycle", example, true);
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/fellows/lifecycle",
      "fellow.lifecycle.change",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let body: unknown;
      try {
        body = verifiedJson(authenticated.rawBody);
      } catch {
        return enrollmentErrorResponse(
          new EnrollmentError("FELLOW_LIFECYCLE_BODY_INVALID"),
          c.req.raw,
        );
      }
      const parsed = SponsorFellowLifecycleRequestSchema.safeParse(body);
      if (!parsed.success) {
        return enrollmentErrorResponse(
          new EnrollmentError("FELLOW_LIFECYCLE_BODY_INVALID"),
          c.req.raw,
        );
      }
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      const response = await options.service.transitionFellow(
        authenticated.principal,
        parsed.data,
        idempotency,
      );
      return c.json(SponsorFellowLifecycleResponseSchema.parse(response), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  app.post("/v1/sponsors/panic", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/sponsors/panic");
    }
    const example = {
      confirm: "revoke-all-fellow-credentials",
      step_up_authenticated_at: 1_786_800_000,
    };
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/sponsors/panic", example, true);
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/sponsors/panic",
      "sponsor.panic",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let body: unknown;
      try {
        body = verifiedJson(authenticated.rawBody);
      } catch {
        return enrollmentErrorResponse(
          new EnrollmentError("SPONSOR_PANIC_BODY_INVALID"),
          c.req.raw,
        );
      }
      const parsed = SponsorPanicRequestSchema.safeParse(body);
      if (!parsed.success) {
        return enrollmentErrorResponse(
          new EnrollmentError("SPONSOR_PANIC_BODY_INVALID"),
          c.req.raw,
        );
      }
      const idempotency = idempotencyOptions(c.req.raw);
      if (idempotency instanceof Response) return idempotency;
      const response = await options.service.panicSponsor(
        authenticated.principal,
        parsed.data,
        idempotency,
      );
      return c.json(SponsorPanicResponseSchema.parse(response), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  // W3.1: the sponsor's first contact bootstraps their row through the single
  // writer. Idempotent by construction; no idempotency key needed.
  app.post("/v1/sponsors/bootstrap", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/sponsors/bootstrap");
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/sponsors/bootstrap", {});
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/sponsors/bootstrap",
      "sponsor.bootstrap",
    );
    if (authenticated instanceof Response) return authenticated;
    const principal = authenticated.principal;
    if (principal.type !== "sponsor") {
      return enrollmentErrorResponse(new EnrollmentError("WRONG_PRINCIPAL"), c.req.raw);
    }
    let bootstrapBody: unknown;
    try {
      bootstrapBody = verifiedJson(authenticated.rawBody);
    } catch {
      return enrollmentErrorResponse(
        new EnrollmentError("SPONSOR_BOOTSTRAP_BODY_INVALID"),
        c.req.raw,
      );
    }
    if (!SponsorBootstrapRequestSchema.safeParse(bootstrapBody).success) {
      return enrollmentErrorResponse(
        new EnrollmentError("SPONSOR_BOOTSTRAP_BODY_INVALID"),
        c.req.raw,
      );
    }
    try {
      const result = await options.service.bootstrapSponsor(principal);
      return c.json(
        SponsorBootstrapResponseSchema.parse({
          sponsor_id: principal.sponsorId,
          created: result.created,
          bootstrapped_at: result.at,
        }),
        result.created ? 201 : 200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });

  // W3.5: the sponsor's entry into the device flow. The user code is the
  // lookup key; the answer is the same approval card the console renders.
  app.post("/v1/device-lookup", async (c) => {
    if (hasQuery(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return sponsorPathOnlyResponse(c.req.raw, "/v1/device-lookup");
    }
    if (!hasJsonContentType(c.req.raw)) {
      cancelUnconsumedRequestBody(c.req.raw);
      return jsonContentTypeRequiredResponse("/v1/device-lookup", {
        user_code: "ABCD-2345",
      });
    }
    const authenticated = await requireSponsor(
      options,
      c.req.raw,
      "/v1/device-lookup",
      "enrollment.device.lookup",
    );
    if (authenticated instanceof Response) return authenticated;
    try {
      let lookupBody: unknown;
      try {
        lookupBody = verifiedJson(authenticated.rawBody);
      } catch {
        return enrollmentErrorResponse(
          new EnrollmentError("DEVICE_LOOKUP_BODY_INVALID"),
          c.req.raw,
        );
      }
      const card = await options.service.deviceLookup(authenticated.principal, lookupBody);
      return c.json(DeviceLookupResponseSchema.parse({ card: contractCard(card) }), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      const operational = enrollmentOperationalFailure(error);
      if (operational !== undefined) return operational;
      return error instanceof EnrollmentError
        ? enrollmentErrorResponse(error, c.req.raw)
        : enrollmentUnavailableResponse();
    }
  });
}
