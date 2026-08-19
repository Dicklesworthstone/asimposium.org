import type { Env } from "../env";
import { problem } from "../http/envelope";
import { isSafeScreeningDiagnosticLabel, isSha256Digest } from "./aggregate";
import { screenWithProvider } from "./provider";
import type { ScreeningObservation, ScreeningRunIdentity } from "./types";
import {
  WORKERS_AI_MAX_BODY_BYTES,
  WORKERS_AI_MODEL_VERSION,
  WORKERS_AI_POLICY_VERSION,
  WorkersAIScreeningProvider,
  type WorkersAiBinding,
  workersAIConfigurationDigest,
} from "./workers-ai";

/**
 * The S-4 staging screening surface (asimposiumorg-xeg): `POST /internal/screen`.
 *
 * The S-4 runner POSTs the evaluable corpus — `{corpus_revision,
 * corpus_digest, partial_run, examples[]}` — behind a bearer, and this route
 * answers with exactly the typed object the runner validates:
 * `{corpus_revision, corpus_digest, model_version, policy_version,
 * configuration_digest, observations[]}`. The response is a bare JSON object
 * by contract, not a success envelope: the runner's
 * `isStagingScreeningResponseObject` reads the identity fields at the top
 * level.
 *
 * Fail-closed discipline (ADR-18):
 *  - no configured bearer or AI binding → a typed 503, identical either way,
 *    so a caller cannot probe which piece a deployment is missing;
 *  - a missing or wrong bearer → a flat 401 that teaches nothing;
 *  - a malformed corpus → a 422 that teaches the *shape* abstractly and never
 *    echoes submitted content, matched text, or classifier reasoning;
 *  - a provider error or timeout → `screenWithProvider`'s quarantine
 *    observation. This route has no branch that turns a provider failure into
 *    a pass.
 *
 * The route recomputes the corpus digest over the submitted `{id, body_digest}`
 * pairs — the same construction as `deriveS4EvaluatedCorpusIdentity` in
 * `e2e/screening/s4-corpus.ts` — and refuses a declared digest that does not
 * match, so the attestation is bound to the examples actually screened rather
 * than to a caller-supplied claim. The runner independently enforces the same
 * equality (`STAGING_CORPUS_IDENTITY_MISMATCH`); the two checks must move
 * together if the construction ever changes.
 */

export const SCREENING_ROUTE_PATH = "/internal/screen";

/** Matches the runner's own response ceiling (MAX_LIVE_JSON_BYTES). */
export const SCREENING_MAX_REQUEST_BYTES = 1_048_576;
/** Headroom over the frozen 150/50 manifest; larger corpora are a new revision. */
export const SCREENING_MAX_EXAMPLES = 512;
/** One provider call must finish well inside the runner's 15s whole-request deadline. */
export const SCREENING_PER_EXAMPLE_TIMEOUT_MS = 12_000;
/** Bounded fan-out: 150 examples at 16-wide keeps the whole screen inside the deadline. */
export const SCREENING_CONCURRENCY = 16;

export interface ScreeningRouteOptions {
  /** Test seam: shorten the per-example provider deadline. */
  readonly perExampleTimeoutMs?: number;
}

interface ScreeningRouteExample {
  readonly id: string;
  readonly body_digest: string;
  readonly body: string;
}

interface ParsedScreeningRequest {
  readonly corpus_revision: string;
  readonly corpus_digest: string;
  readonly examples: readonly ScreeningRouteExample[];
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare through SHA-256 so the loop bound does not leak the expected token's
 * length, and so the comparison cost is independent of where a mismatch sits.
 */
async function bearerMatches(header: string | null, expected: string): Promise<boolean> {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (presented.length < 16) return false;
  const [presentedDigest, expectedDigest] = await Promise.all([
    sha256Hex(presented),
    sha256Hex(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= presentedDigest.charCodeAt(index) ^ expectedDigest.charCodeAt(index);
  }
  return difference === 0 && presentedDigest.length === expectedDigest.length;
}

/** The whole request body, or `undefined` when it crosses the byte ceiling. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is cleanup, never the outcome.
        }
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Preserve the bounded-read outcome.
    }
  }
  const complete = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    complete.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(complete);
}

/**
 * Shape validation only: what the route needs to screen, nothing retained.
 * Returns a coarse refusal code whose detail teaches the shape without quoting
 * a single submitted byte.
 */
function parseScreeningRequest(
  value: unknown,
): { ok: true; request: ParsedScreeningRequest } | { ok: false; code: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "SCREENING_REQUEST_MALFORMED" };
  }
  const body = value as {
    corpus_revision?: unknown;
    corpus_digest?: unknown;
    partial_run?: unknown;
    examples?: unknown;
  };
  if (
    !isSafeScreeningDiagnosticLabel(body.corpus_revision) ||
    !isSha256Digest(body.corpus_digest) ||
    typeof body.partial_run !== "boolean" ||
    !Array.isArray(body.examples) ||
    body.examples.length === 0 ||
    body.examples.length > SCREENING_MAX_EXAMPLES
  ) {
    return { ok: false, code: "SCREENING_REQUEST_MALFORMED" };
  }
  const examples: ScreeningRouteExample[] = [];
  const seen = new Set<string>();
  for (const entry of body.examples) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, code: "SCREENING_REQUEST_MALFORMED" };
    }
    const candidate = entry as {
      id?: unknown;
      body_digest?: unknown;
      body?: unknown;
      source?: unknown;
    };
    if (!isSafeScreeningDiagnosticLabel(candidate.id) || seen.has(candidate.id)) {
      return { ok: false, code: "SCREENING_REQUEST_MALFORMED" };
    }
    if (!isSha256Digest(candidate.body_digest)) {
      return { ok: false, code: "SCREENING_REQUEST_MALFORMED" };
    }
    // Only inline-safe, available material is evaluable today: staging holds
    // no protected-body resolver yet, and screening an entry whose body never
    // arrived would attest a digest the screened bytes do not hash to. This is
    // a corpus-side gap, so it gets its own code rather than the generic one.
    const source = candidate.source;
    const sourceKind =
      typeof source === "object" && source !== null && "kind" in source ? source.kind : undefined;
    const sourceAvailability =
      typeof source === "object" && source !== null && "availability" in source
        ? source.availability
        : undefined;
    if (
      sourceKind !== "inline-safe" ||
      sourceAvailability !== "available" ||
      typeof candidate.body !== "string" ||
      new TextEncoder().encode(candidate.body).byteLength > WORKERS_AI_MAX_BODY_BYTES
    ) {
      return { ok: false, code: "SCREENING_BODY_UNEVALUABLE" };
    }
    seen.add(candidate.id);
    examples.push({ id: candidate.id, body_digest: candidate.body_digest, body: candidate.body });
  }
  return {
    ok: true,
    request: {
      corpus_revision: body.corpus_revision,
      corpus_digest: body.corpus_digest,
      examples,
    },
  };
}

function screeningUnavailable(): Response {
  // Deliberately identical for a missing bearer and a missing AI binding:
  // which piece a deployment lacks is operator information, not caller
  // information.
  return problem({
    status: 503,
    code: "SCREENING_UNAVAILABLE",
    title: "Screening is not configured on this Worker",
    detail: "This deployment does not carry the staging screening configuration.",
    fixHint: "Retry against the staging deployment that carries the screening configuration.",
  });
}

function screeningProblem(status: number, code: string, detail: string, fixHint: string): Response {
  return problem({ status, code, title: "Screening request refused", detail, fixHint });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(lanes);
  return results.map((result) => result as R);
}

export async function handleScreeningRequest(
  request: Request,
  env: Env,
  options: ScreeningRouteOptions = {},
): Promise<Response> {
  // Configuration gates first: a disabled surface does not read untrusted
  // bodies, and the two 503s are indistinguishable by construction.
  const bearer = env.S4_SCREENING_BEARER;
  if (typeof bearer !== "string" || bearer.trim().length < 16) return screeningUnavailable();
  const ai = env.AI;
  if (ai === undefined || ai === null || typeof ai.run !== "function") {
    return screeningUnavailable();
  }

  if (!(await bearerMatches(request.headers.get("authorization"), bearer))) {
    return problem({
      status: 401,
      code: "SCREENING_UNAUTHORIZED",
      title: "Screening requires authorization",
      detail: "The request did not carry a valid screening bearer.",
      fixHint: "Retry with the staging screening bearer for this environment.",
      headers: { "www-authenticate": "Bearer" },
    });
  }

  const text = await readBoundedBody(request, SCREENING_MAX_REQUEST_BYTES);
  if (text === undefined) {
    return screeningProblem(
      413,
      "SCREENING_REQUEST_TOO_LARGE",
      "The screening corpus body exceeds the byte ceiling for one attestation request.",
      "Resubmit with the frozen S-4 corpus, which fits the documented ceiling.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return screeningProblem(
      422,
      "SCREENING_REQUEST_MALFORMED",
      "The body must be one JSON object: corpus_revision, corpus_digest, partial_run, examples.",
      "Resubmit with the documented S-4 corpus request shape.",
    );
  }
  const parsedRequest = parseScreeningRequest(parsed);
  if (!parsedRequest.ok) {
    const unevaluable = parsedRequest.code === "SCREENING_BODY_UNEVALUABLE";
    return screeningProblem(
      422,
      parsedRequest.code,
      unevaluable
        ? "Every submitted example must carry an available inline body bound to its digest; this staging deployment evaluates no other source kind."
        : "The corpus request must name a corpus revision and digest, a partial_run flag, and 1..512 examples each with id, body_digest, source, and an inline body.",
      unevaluable
        ? "Submit only digest-bound inline examples; protected staging material joins when its resolver lands."
        : "Resubmit with the documented S-4 corpus request shape.",
    );
  }
  const submission = parsedRequest.request;

  // Bind each declared digest to the bytes actually present before any of them
  // reaches the provider; the refusal names the check, never the content.
  for (const example of submission.examples) {
    if ((await sha256Hex(example.body)) !== example.body_digest.slice("sha256:".length)) {
      return screeningProblem(
        422,
        "SCREENING_BODY_DIGEST_MISMATCH",
        "At least one submitted body does not hash to its declared body_digest.",
        "Recompute the corpus manifest digests and resubmit.",
      );
    }
  }

  // The corpus digest is recomputed here (sorted {id, body_digest} members,
  // the same construction the runner derives) so the response attests the set
  // that was screened rather than the set the caller claimed.
  const members = submission.examples
    .map((example) => ({ id: example.id, body_digest: example.body_digest }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const recomputedDigest = `sha256:${await sha256Hex(JSON.stringify(members))}`;
  if (recomputedDigest !== submission.corpus_digest) {
    return screeningProblem(
      422,
      "SCREENING_CORPUS_DIGEST_MISMATCH",
      "The declared corpus_digest does not match the submitted example set.",
      "Recompute the evaluated-corpus identity over the submitted examples and resubmit.",
    );
  }

  const identity: ScreeningRunIdentity = {
    corpus_revision: submission.corpus_revision,
    corpus_digest: submission.corpus_digest,
    model_version: WORKERS_AI_MODEL_VERSION,
    policy_version: WORKERS_AI_POLICY_VERSION,
    configuration_digest: await workersAIConfigurationDigest(),
  };
  // Bodies live in this map for exactly the screening of this request. The
  // provider request carries digests only; the resolver is the one seam
  // through which a body reaches the model, and nothing here retains it.
  const bodies = new Map(submission.examples.map((example) => [example.id, example.body]));
  const provider = new WorkersAIScreeningProvider(ai as unknown as WorkersAiBinding, {
    resolveBody: (providerRequest) => {
      const body = bodies.get(providerRequest.example_id);
      if (body === undefined) throw new TypeError("No verified body for this screening request.");
      return body;
    },
  });
  const timeoutMs = options.perExampleTimeoutMs ?? SCREENING_PER_EXAMPLE_TIMEOUT_MS;
  const observations: readonly ScreeningObservation[] = await mapWithConcurrency(
    submission.examples,
    SCREENING_CONCURRENCY,
    (example) =>
      screenWithProvider(
        provider,
        {
          example_id: example.id,
          body_digest: example.body_digest,
          // Corpus entries carry no conversational context; the harness binds
          // the context digest to the body digest identically.
          context_digest: example.body_digest,
          identity,
        },
        { timeout_ms: timeoutMs },
      ),
  );

  return new Response(
    `${JSON.stringify({
      corpus_revision: identity.corpus_revision,
      corpus_digest: identity.corpus_digest,
      model_version: identity.model_version,
      policy_version: identity.policy_version,
      configuration_digest: identity.configuration_digest,
      observations,
    })}\n`,
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
