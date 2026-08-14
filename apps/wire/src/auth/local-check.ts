#!/usr/bin/env bun
/**
 * S-6 local ingress checker (bead asimposiumorg-vw3).
 *
 * Drives the harness Worker over real HTTP and emits one NDJSON record per
 * assertion. Records carry assertion name, status and a bounded detail; never a
 * cookie, a signature, a bearer, key material, a payload body, or a local path.
 *
 * Scope is stated in every summary record and never inflated: this is local
 * workerd plus local D1 on one machine. It is not deployed proof.
 */

import {
  mintServiceEnvelope,
  type ServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../../web/lib/service-envelope";

/** Every request in this checker is bounded by this deadline. */
export const LOCAL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Validate the harness origin as an exact http loopback origin.
 *
 * `!== undefined` is not validation. This checker mints signed envelopes and
 * sends them wherever `S6_ORIGIN` points, so a stray value turns a local proof
 * into an outbound request carrying real signatures: `https://example.com`,
 * `http://127.0.0.1@evil.test` (userinfo, so the host is `evil.test`), or a
 * value with a path that silently reparents every route. The rule is therefore
 * an exact shape — http, a loopback host, an explicit port, and nothing else —
 * rather than a substring test that any of those would pass.
 */
export function validateLoopbackOrigin(value: string | undefined): URL {
  if (value === undefined || value === "") {
    throw new Error("S6_ORIGIN is not set");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("S6_ORIGIN is not a URL");
  }
  if (url.protocol !== "http:") throw new Error("S6_ORIGIN must use http on loopback");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") {
    throw new Error("S6_ORIGIN host must be loopback");
  }
  // Userinfo is the classic way to make a hostile host read as a loopback one.
  if (url.username !== "" || url.password !== "") {
    throw new Error("S6_ORIGIN must carry no credentials");
  }
  if (url.port === "") throw new Error("S6_ORIGIN must name an explicit port");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("S6_ORIGIN must have an empty path, query and fragment");
  }
  return url;
}

let validatedOrigin: URL | undefined;
try {
  validatedOrigin = validateLoopbackOrigin(process.env.S6_ORIGIN);
} catch {
  validatedOrigin = undefined;
}
const origin = validatedOrigin === undefined ? undefined : validatedOrigin.origin;

/**
 * The only fetch this checker performs.
 *
 * A bare `fetch` has no deadline, so a Worker that accepts a connection and
 * never answers hangs the checker forever — and the runner's own timeout then
 * has to kill it, turning a precise assertion failure into an opaque timeout.
 * `AbortSignal.timeout` keeps the failure attributable to the request that
 * caused it.
 */
export async function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS) });
}

/**
 * The JWK shape this loader hands to WebCrypto.
 *
 * Declared structurally rather than by naming the platform's `JsonWebKey`,
 * which is not in scope here: this file runs under Bun while the package's
 * ambient crypto types come from the Workers definitions. `kty` is required —
 * the platform type requires it too — and every other member stays optional and
 * is passed through untouched. Nothing in this file ever reads `d`.
 */
interface HarnessJwk {
  kty: string;
  crv?: string;
  x?: string;
  d?: string;
  alg?: string;
  ext?: boolean;
  key_ops?: string[];
  use?: string;
}

/** Why the harness signing key could not be loaded. Never carries the key. */
export type SigningKeyFailure =
  | "S6_HARNESS_KEY_MISSING"
  | "S6_HARNESS_KEY_MALFORMED"
  | "S6_HARNESS_KEY_UNUSABLE";

export interface SigningKeyResult {
  ok: boolean;
  key?: CryptoKey;
  code?: SigningKeyFailure;
  detail?: string;
}

/**
 * Load the harness signing key, failing closed.
 *
 * `JSON.parse(env)` and `importKey` were both unguarded, so a malformed or
 * wrong-curve JWK crashed the checker with an unhandled rejection. That is the
 * wrong failure in two ways. It is not fail-closed — the process dies rather
 * than emitting a refusal record the runner can attribute — and it is not
 * quiet: a JSON parser's message routinely quotes the offending input, and the
 * input here is a *private key*, so the crash path is a plausible way to print
 * key material into a log.
 *
 * Every diagnostic below is therefore a fixed string. Neither the environment
 * value nor the platform's own error message is ever included, because the
 * latter is exactly where the former reappears.
 */
export async function loadSigningKey(raw: string | undefined): Promise<SigningKeyResult> {
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      code: "S6_HARNESS_KEY_MISSING",
      detail: "S6_PRIVATE_KEY_JWK is not set; the launcher must export the ephemeral harness key",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message is discarded on purpose: it quotes the input.
    return {
      ok: false,
      code: "S6_HARNESS_KEY_MALFORMED",
      detail: "S6_PRIVATE_KEY_JWK is not valid JSON (value withheld)",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "S6_HARNESS_KEY_MALFORMED",
      detail: "S6_PRIVATE_KEY_JWK must be a JWK object (value withheld)",
    };
  }

  // Shape-check before importKey so the common mistakes get a precise code
  // rather than a generic platform failure. Only key *metadata* is inspected;
  // `d` is never read, compared, or reported.
  const jwk = parsed as { kty?: unknown; crv?: unknown };
  if (typeof jwk.kty !== "string" || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    return {
      ok: false,
      code: "S6_HARNESS_KEY_MALFORMED",
      detail: "S6_PRIVATE_KEY_JWK must be an OKP/Ed25519 JWK (value withheld)",
    };
  }
  const keyData: HarnessJwk = parsed as HarnessJwk;

  try {
    // `kty` and `crv` were both checked above, so this narrowing is earned
    // rather than asserted: the object is known to carry a string `kty`, which
    // is the only member the platform's JWK type requires.
    const key = await crypto.subtle.importKey("jwk", keyData, { name: "Ed25519" }, false, ["sign"]);
    return { ok: true, key };
  } catch {
    return {
      ok: false,
      code: "S6_HARNESS_KEY_UNUSABLE",
      detail: "S6_PRIVATE_KEY_JWK did not import as an Ed25519 signing key (value withheld)",
    };
  }
}

const REPRODUCE = "bash scripts/e2e-s6-auth-ingress.sh";
const ROUTE = "/__s6/ingress";
const ACTION = "s6.probe";
const NOW = Number.parseInt(process.env.S6_NOW ?? "", 10);
const KID = process.env.S6_KID ?? "s6-local";
/** Never sent as a real credential; asserted to appear nowhere in any output. */
const COOKIE_CANARY = "s6canary_do_not_echo_0f1e2d3c";

let failures = 0;

function emit(record: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ suite: "s6-auth-ingress-local", reproduce: REPRODUCE, ...record })}\n`,
  );
}

function check(assertion: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  emit({ assertion, status: ok ? "pass" : "fail", detail: ok ? "as expected" : detail });
}

interface Sent {
  status: number;
  body: Record<string, unknown>;
  cookieReads: string | null;
  diagnostic: string | null;
}

async function send(
  envelope: ServiceEnvelope,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<Sent> {
  const headers = new Headers(serviceEnvelopeHeaders(envelope));
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  const response = await localFetch(`${origin}${ROUTE}`, { method: "POST", headers, body });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: parsed,
    cookieReads: response.headers.get("x-s6-cookie-reads"),
    diagnostic: response.headers.get("x-s6-diagnostic"),
  };
}

async function main(): Promise<void> {
  if (origin === undefined || !Number.isSafeInteger(NOW)) {
    emit({
      assertion: "harness_configured",
      status: "fail",
      detail:
        "S6_ORIGIN must be an http loopback origin with an explicit port, no credentials, and an empty path/query/fragment; S6_NOW must be an integer",
    });
    process.exitCode = 1;
    return;
  }

  const loaded = await loadSigningKey(process.env.S6_PRIVATE_KEY_JWK);
  if (!loaded.ok || loaded.key === undefined) {
    // A refusal record, not a crash: the runner can attribute this to harness
    // configuration instead of reading a stack trace and guessing.
    emit({
      assertion: "harness_signing_key_loaded",
      status: "fail",
      code: loaded.code,
      detail: loaded.detail,
    });
    process.exitCode = 1;
    return;
  }
  const privateKey = loaded.key;

  const sign = async (
    body: string,
    overrides: Partial<{ route: string; method: string; action: string; now: number }> = {},
  ) =>
    await mintServiceEnvelope({
      privateKey,
      kid: KID,
      now: overrides.now ?? NOW,
      method: overrides.method ?? "POST",
      route: overrides.route ?? ROUTE,
      action: overrides.action ?? ACTION,
      principalId: "usr_01JXYZ0000000000000000",
      body,
    });

  // ── 1. concurrent byte-identical replay: one effect, one refusal ──────────
  {
    const body = '{"claim":"C-1","n":1}';
    const envelope = await sign(body);
    const [first, second] = await Promise.all([send(envelope, body), send(envelope, body)]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    check(
      "concurrent_identical_envelopes_yield_one_accepted_effect",
      statuses[0] === 200 && statuses[1] !== 200,
      `statuses ${statuses.join(",")}`,
    );
    check(
      "the_loser_is_refused_not_errored",
      statuses[1] === 401 || statuses[1] === 403,
      `loser status ${statuses[1]}`,
    );
    const third = await send(envelope, body);
    check("a_third_presentation_stays_refused", third.status !== 200, `status ${third.status}`);
  }

  // ── 2. cookie is never consulted, and the canary never appears ────────────
  {
    const body = '{"claim":"C-2","n":2}';
    const sent = await send(await sign(body), body, {
      cookie: `__Host-authjs.session-token=${COOKIE_CANARY}`,
    });
    check(
      "a_request_bearing_a_cookie_still_authenticates",
      sent.status === 200,
      `status ${sent.status}`,
    );
    check(
      "the_worker_never_read_the_cookie_header",
      sent.cookieReads === "0",
      `reads=${String(sent.cookieReads)}`,
    );
    const surfaces = `${JSON.stringify(sent.body)}${sent.diagnostic ?? ""}`;
    check("no_canary_in_body_or_diagnostic", !surfaces.includes(COOKIE_CANARY), "canary echoed");
  }

  // ── 3. principal routing, both directions ────────────────────────────────
  {
    const bearerOnSponsor = await localFetch(
      `${origin}/__s6/principal?host=apex&route_class=sponsor-write&bearer=1`,
    );
    check(
      "bearer_on_sponsor_route_is_wrong_principal",
      bearerOnSponsor.status === 403 &&
        bearerOnSponsor.headers.get("x-s6-principal-reason") === "bearer_on_sponsor_route",
      `status ${bearerOnSponsor.status} reason ${String(bearerOnSponsor.headers.get("x-s6-principal-reason"))}`,
    );
    const cookieOnAgent = await localFetch(
      `${origin}/__s6/principal?host=agent&route_class=agent-write&envelope=1`,
    );
    check(
      "envelope_on_the_agent_write_route_is_wrong_principal",
      cookieOnAgent.status === 403,
      `status ${cookieOnAgent.status}`,
    );
    const agentConsults = await localFetch(
      `${origin}/__s6/principal?host=agent&route_class=service-envelope-worker&envelope=1`,
    );
    const consulted = agentConsults.headers.get("x-s6-consulted") ?? "";
    const consultedBody = (await agentConsults.json()) as { consulted?: string[] };
    check(
      "the_agent_host_never_lists_cookie_as_a_consulted_credential",
      !`${consulted}${(consultedBody.consulted ?? []).join(",")}`.toLowerCase().includes("cookie"),
      "cookie named as consulted",
    );
  }

  // ── 4. a reordered body is refused and does NOT consume the valid nonce ───
  {
    const signedBytes = '{"claim":"C-4","n":4}';
    const reordered = '{"n":4,"claim":"C-4"}';
    const envelope = await sign(signedBytes);
    const rewritten = await send(envelope, reordered);
    check("reordered_json_body_is_refused", rewritten.status !== 200, `status ${rewritten.status}`);
    const honest = await send(envelope, signedBytes);
    check(
      "the_refused_rewrite_did_not_consume_the_nonce",
      honest.status === 200,
      `the honest retry got ${honest.status}; a refused body must not burn its envelope`,
    );
  }

  // ── 5. altered route / method / action / expiry / tamper / key ────────────
  {
    const body = '{"claim":"C-5","n":5}';
    const cases: [string, () => Promise<Sent>][] = [
      [
        "altered_route_is_refused",
        async () => send(await sign(body, { route: "/__s6/other" }), body),
      ],
      ["altered_method_is_refused", async () => send(await sign(body, { method: "PUT" }), body)],
      [
        "unpermitted_action_is_refused",
        async () => send(await sign(body, { action: "s6.other" }), body),
      ],
      [
        "expired_envelope_is_refused",
        async () => send(await sign(body, { now: NOW - 86_400 }), body),
      ],
      [
        "tampered_signature_is_refused",
        async () => {
          const envelope = (await sign(body)) as unknown as Record<string, unknown>;
          const signature = String(envelope.signature ?? "");
          const flipped = `${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "AB" : "AA"}`;
          return send({ ...envelope, signature: flipped } as unknown as ServiceEnvelope, body);
        },
      ],
      [
        "unknown_kid_is_refused",
        async () => {
          const envelope = (await sign(body)) as unknown as Record<string, unknown>;
          return send(
            { ...envelope, kid: "s6-not-in-keyring" } as unknown as ServiceEnvelope,
            body,
          );
        },
      ],
      ["altered_payload_is_refused", async () => send(await sign(body), '{"claim":"C-5","n":999}')],
    ];
    for (const [assertion, run] of cases) {
      const sent = await run();
      check(assertion, sent.status !== 200, `status ${sent.status}`);
    }
  }

  // ── 6. diagnostics are redacted ──────────────────────────────────────────
  {
    const body = '{"claim":"C-6","n":6}';
    const envelope = await sign(body);
    const signature = String((envelope as unknown as Record<string, unknown>).signature ?? "");
    const sent = await send(envelope, body);
    const diagnostic = sent.diagnostic ?? "";
    check("an_accepted_request_emits_a_diagnostic", diagnostic.length > 0, "no diagnostic header");
    check(
      "the_diagnostic_never_carries_the_signature",
      !diagnostic.includes(signature),
      "signature echoed",
    );
    check(
      "the_diagnostic_never_carries_the_principal_id",
      !diagnostic.includes("usr_01JXYZ0000000000000000"),
      "raw principal id echoed",
    );
    check(
      "the_diagnostic_never_carries_the_payload_body",
      !diagnostic.includes('"claim":"C-6"'),
      "payload echoed",
    );
    check(
      "the_diagnostic_labels_its_claim_state",
      diagnostic.includes("authenticated_claim"),
      "missing claim-state label",
    );
  }

  emit({
    assertion: "local_ingress_summary",
    status: failures === 0 ? "pass" : "fail",
    detail:
      failures === 0
        ? "real local workerd + real local D1 ingress checks passed"
        : `${failures} assertion(s) failed`,
    scope: "local-workerd + local-D1 on one machine; not deployed proof",
  });
  if (failures > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
