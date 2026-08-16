/**
 * RFC 7807 faces for authentication decisions.
 *
 * The verifier keeps a precise internal refusal enum for diagnostics, but a
 * signature failure is a policy refusal under Rule A5 and must not become a
 * forgery oracle. These faces therefore distinguish only the safe transport
 * classes: unauthorized, wrong credential class, and replay-store outage.
 */
import { validatedProblem as problem } from "../http/envelope";
import type { EnvelopeRefusalReason } from "./envelope";

export function envelopeRefusalProblem(reason: EnvelopeRefusalReason): Response {
  if (reason === "store_unavailable") {
    return problem({
      status: 503,
      code: "AUTH_REPLAY_STORE_UNAVAILABLE",
      title: "Authorization replay defense is unavailable",
      detail: "The request was not accepted because authorization replay defense is unavailable.",
      fixHint: "Retry the request. If the condition persists, contact the sponsor.",
    });
  }

  return problem({
    status: 401,
    code: "UNAUTHORIZED",
    title: "Authorization was not accepted",
    detail: "The request did not include an authorization accepted by this route.",
    fixHint: "Obtain a fresh sponsor authorization and retry the request.",
  });
}

/** Coarse refusal for a body that exceeded the pre-authentication byte cap. */
export function requestBodyTooLargeProblem(): Response {
  return problem({
    status: 413,
    code: "REQUEST_BODY_TOO_LARGE",
    title: "Request body is too large",
    detail: "The request body exceeded the maximum size accepted by this service route.",
    fixHint:
      "Send a smaller request body and obtain a fresh sponsor authorization before retrying.",
  });
}

/** Safe, route-level refusal for bearer/envelope/cookie class confusion. */
export function wrongPrincipalProblem(): Response {
  return problem({
    status: 403,
    code: "WRONG_PRINCIPAL",
    title: "Credential cannot authorize this route",
    detail: "The credential class presented cannot authorize this route.",
    fixHint: "Use the credential class required by this route and hostname.",
  });
}
