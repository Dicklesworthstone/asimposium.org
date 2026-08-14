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

import { closeSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  mintServiceEnvelope,
  type ServiceEnvelope,
  serviceEnvelopeHeaders,
} from "../../../web/lib/service-envelope";
import { principalPseudonym } from "./diagnostics";

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
  return await fetch(url, {
    ...init,
    // Both of these are set *after* the spread so a caller cannot override
    // them, deliberately or by copying an init object around.
    //
    // `redirect: "manual"` is a proof-integrity control, not a nicety. The
    // default is "follow", so a Worker answering 302 would make this checker
    // re-send a *signed service envelope* to whatever Location named — a second
    // origin, off loopback, carrying real credentials — and the run would still
    // report the assertion as passing against a response it never validated the
    // provenance of. Manual redirects keep every request on the origin this
    // harness validated.
    redirect: "manual",
    signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
  });
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
/** The verifier's second mount. Same handler, different path. */
const ALIAS_ROUTE = "/__s6/ingress-alias";
const ACTION = "s6.probe";
/** The acting principal every signed envelope in this run names. */
const PRINCIPAL_ID = "usr_01JXYZ0000000000000000";
/** Must match the launcher's `--var S6_PSEUDONYM_SALT`. */
const PSEUDONYM_SALT = "s6-local-salt";
/** `full` runs the whole suite; the persist phases straddle a worker restart. */
const PHASE = process.env.S6_PHASE ?? "full";
const NOW = Number.parseInt(process.env.S6_NOW ?? "", 10);
const KID = process.env.S6_KID ?? "s6-local";
/** Never sent as a real credential; asserted to appear nowhere in any output. */
const COOKIE_CANARY = "s6canary_do_not_echo_0f1e2d3c";

/**
 * The single filename the restart handoff may occupy, and the cap on reading it.
 *
 * An env-supplied *path* was the wrong interface. `S6_PERSIST_ENVELOPE_PATH`
 * accepted any absolute path and `Bun.write` truncates whatever is there, so a
 * stray or hostile value turned this checker into an arbitrary-file overwrite
 * with the harness's own permissions -- and AGENTS.md keeps artifact roots under
 * the repository's control precisely so a test cannot do that. The launcher now
 * passes the state *directory* it created, and the filename is fixed here where
 * no environment can reach it.
 */
export const HANDOFF_FILENAME = "persisted-envelope.json";
/** One envelope and one small body. Anything larger is not our file. */
export const HANDOFF_MAX_BYTES = 16 * 1024;

export type HandoffPath = { ok: true; path: string } | { ok: false; detail: string };

/**
 * Resolve the one file this checker may write.
 *
 * Every rejection below is a fixed string: no candidate path, no envelope, no
 * nonce and no body ever reaches a diagnostic.
 */
export function resolveHandoffPath(stateDir: string | undefined): HandoffPath {
  if (stateDir === undefined || stateDir === "" || !stateDir.startsWith("/")) {
    return { ok: false, detail: "S6_STATE_DIR must be an absolute path" };
  }
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(stateDir);
  } catch {
    return { ok: false, detail: "S6_STATE_DIR does not exist" };
  }
  // `lstat`, not `stat`: a symlinked state dir would resolve elsewhere and the
  // exclusive create below would land wherever it pointed.
  if (entry.isSymbolicLink()) return { ok: false, detail: "S6_STATE_DIR must not be a symlink" };
  if (!entry.isDirectory()) return { ok: false, detail: "S6_STATE_DIR must be a directory" };
  let resolved: string;
  try {
    resolved = realpathSync(stateDir);
  } catch {
    return { ok: false, detail: "S6_STATE_DIR could not be resolved" };
  }
  // Resolve first, then work from the resolved path, so the destination is
  // decided once rather than re-walked at open time.
  //
  // Requiring `resolved === stateDir` was the obvious-looking rule and it was
  // wrong: on macOS `mktemp -d` hands back `/var/folders/...` while `/var` is a
  // system symlink to `/private/var`, so every legitimate run failed. It also
  // was not the protection it looked like -- resolving to the same place is
  // exactly what a redirected write does. The containment that actually holds is
  // below, plus the exclusive create at the leaf.
  let resolvedEntry: ReturnType<typeof lstatSync>;
  try {
    resolvedEntry = lstatSync(resolved);
  } catch {
    return { ok: false, detail: "S6_STATE_DIR does not resolve to an existing directory" };
  }
  if (!resolvedEntry.isDirectory()) {
    return { ok: false, detail: "S6_STATE_DIR does not resolve to a directory" };
  }
  // The handoff is a per-run scratch credential and belongs in the run's private
  // temp directory. It must never be written into the checkout -- that is the
  // artifact-root rule, and a state dir pointing at the repository (or at a
  // parent of it) is a misconfiguration worth refusing rather than obeying.
  let cwd: string;
  try {
    cwd = realpathSync(process.cwd());
  } catch {
    return { ok: false, detail: "the working directory could not be resolved" };
  }
  if (resolved === cwd || resolved.startsWith(`${cwd}/`) || cwd.startsWith(`${resolved}/`)) {
    return { ok: false, detail: "S6_STATE_DIR must be outside the checkout" };
  }
  return { ok: true, path: join(resolved, HANDOFF_FILENAME) };
}

/** The handoff shape, validated rather than trusted on the way back in. */
interface Handoff {
  envelope: ServiceEnvelope;
  body: string;
}

export function parseHandoff(
  raw: string,
): { ok: true; value: Handoff } | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser quotes its input, and the input is a signed envelope.
    return { ok: false, detail: "the restart handoff is not valid JSON (contents withheld)" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "the restart handoff is not an object (contents withheld)" };
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "body,envelope") {
    return { ok: false, detail: "the restart handoff has unexpected top-level members" };
  }
  if (typeof record.body !== "string") {
    return { ok: false, detail: "the restart handoff body is not a string" };
  }
  const envelope = record.envelope;
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, detail: "the restart handoff envelope is not an object" };
  }
  const envelopeRecord = envelope as Record<string, unknown>;
  if (Object.keys(envelopeRecord).sort().join(",") !== "claims,signature") {
    return { ok: false, detail: "the restart handoff envelope has unexpected members" };
  }
  if (typeof envelopeRecord.signature !== "string") {
    return { ok: false, detail: "the restart handoff signature is not a string" };
  }
  const claims = envelopeRecord.claims;
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, detail: "the restart handoff claims are not an object" };
  }
  return { ok: true, value: { envelope: envelope as ServiceEnvelope, body: record.body } };
}

/**
 * Create the handoff file, or refuse.
 *
 * `wx` is O_CREAT|O_EXCL: it fails on an existing file *and* on an existing
 * symlink, so this can neither follow a planted link nor truncate anything it
 * did not create. A plain `w` here -- or `Bun.write`, which is what this
 * replaced -- silently destroys whatever holds the name.
 *
 * Nothing is deleted to make room. If the name is taken, the run says so and
 * stops, because removing a file to complete a *test* is exactly the behaviour
 * the no-delete rule exists to forbid.
 */
export function writeHandoffExclusively(
  path: string,
  payload: string,
): { ok: true } | { ok: false; detail: string } {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return {
      ok: false,
      detail: "the restart handoff already existed or could not be created exclusively",
    };
  }
  try {
    writeSync(fd, payload);
  } catch {
    return { ok: false, detail: "the restart handoff could not be written" };
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

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

/**
 * Emit the run summary and set the exit code.
 *
 * Shared by every exit path, including the restart phases. A phase that
 * returned early without this would exit 0 with failures recorded — the
 * launcher would read a green exit and the failed assertions would sit in the
 * NDJSON unnoticed.
 */
function finish(): void {
  emit({
    assertion: "local_ingress_summary",
    status: failures === 0 ? "pass" : "fail",
    detail:
      failures === 0
        ? `real local workerd + real local D1 ingress checks passed (phase ${PHASE})`
        : `${failures} assertion(s) failed`,
    scope: "local-workerd + local-D1 on one machine; not deployed proof",
    phase: PHASE,
  });
  if (failures > 0) process.exitCode = 1;
}

/** The refusal vocabulary the adapter is contracted to return. */
export const EXPECTED_REFUSAL = {
  /** Envelope verification failed: tamper, expiry, unknown key, bound-byte mismatch, replay. */
  unauthorized: { status: 401, code: "UNAUTHORIZED" },
  /** The wrong credential class for the host/route pair. */
  wrongPrincipal: { status: 403, code: "WRONG_PRINCIPAL" },
} as const;

/**
 * Decide whether one response is the exact refusal a case requires.
 *
 * `status !== 200` was not an assertion of anything. A 500 from a broken
 * binding, a 404 from a mistyped route, and a 502 from a dead Worker all
 * satisfied it, so the suite reported "refused as expected" for a harness that
 * had simply failed — the precise shape of a test that cannot fail for the
 * reason it claims to test. A refusal is now an exact status *and* an exact
 * code, and a server error is called out as its own condition so it can never
 * be read as proof.
 */
export function classifyRefusal(
  status: number,
  body: Record<string, unknown>,
  expected: { status: number; code: string },
): { ok: boolean; detail: string } {
  if (status >= 500) {
    return {
      ok: false,
      detail: `server error ${status} is not a refusal (code ${String(body.code ?? "none")})`,
    };
  }
  if (status === 200) return { ok: false, detail: "accepted; a refusal was required" };
  if (status !== expected.status) {
    return { ok: false, detail: `status ${status}, expected ${expected.status}` };
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (code !== expected.code) {
    return { ok: false, detail: `code ${code || "none"}, expected ${expected.code}` };
  }
  return { ok: true, detail: "as expected" };
}

/** Assert one response is exactly the required refusal. */
function checkRefusal(
  assertion: string,
  sent: Sent,
  expected: { status: number; code: string } = EXPECTED_REFUSAL.unauthorized,
): void {
  const verdict = classifyRefusal(sent.status, sent.body, expected);
  check(assertion, verdict.ok, verdict.detail);
}

/**
 * Assert an accepted ingress response is the *right* acceptance.
 *
 * `status === 200` alone would pass for an acceptance attributed to the wrong
 * action or the wrong principal, which is the failure that matters most here:
 * the whole point of the envelope is that it binds a specific acting principal
 * to a specific permitted action. The expected pseudonym is derived with the
 * same function and salt the Worker uses, so this compares against a computed
 * value rather than whatever the response happened to contain.
 */
/** `payload_digest_prefix` is this many hex characters. Mirrors `diagnostics.ts`. */
const DIAGNOSTIC_DIGEST_PREFIX = 12;

/**
 * Assert the *full* positive shape of an accepted ingress response.
 *
 * A 200 is not an acceptance. `status === 200` alone is satisfied by a handler
 * that answered the wrong request, attributed the effect to nobody, or -- the
 * one that matters most here -- emitted telemetry labelling attacker-supplied
 * envelope fields as authenticated. Every refusal assertion in this file can
 * pass against such a handler, because refusals are the only thing they look at.
 *
 * So an acceptance must show all of it: the envelope was honoured (`ok`), it was
 * honoured *as this action* for *this principal*, against the request actually
 * presented (route, method, payload digest, byte count), and the diagnostic
 * record says `accepted`/`OK` with every claim state marked
 * `authenticated_claim` -- the label a refusal is structurally forbidden from
 * carrying.
 */
async function checkAccepted(assertion: string, sent: Sent, expectedAction: string): Promise<void> {
  const expectedPseudonym = await principalPseudonym(PRINCIPAL_ID, PSEUDONYM_SALT);
  const ok = sent.body.ok === true;
  const action = String(sent.body.action ?? "");
  const pseudonym = String(sent.body.principal_pseudonym ?? "");
  const bodyBytes = sent.body.body_bytes;
  check(
    assertion,
    sent.status === 200 &&
      ok &&
      action === expectedAction &&
      pseudonym === expectedPseudonym &&
      bodyBytes === sent.sentBytes,
    `status ${sent.status} ok ${String(sent.body.ok)} action ${action || "none"} ` +
      `pseudonym ${pseudonym === expectedPseudonym ? "ok" : pseudonym ? "mismatch" : "absent"} ` +
      `body_bytes ${String(bodyBytes)} expected ${sent.sentBytes}`,
  );

  // The diagnostic is the part that becomes telemetry, so it is asserted in
  // full rather than sampled.
  let diagnostic: Record<string, unknown> = {};
  let parsedDiagnostic = false;
  try {
    diagnostic = JSON.parse(sent.diagnostic ?? "") as Record<string, unknown>;
    parsedDiagnostic = diagnostic !== null && typeof diagnostic === "object";
  } catch {
    parsedDiagnostic = false;
  }
  const expectedPrefix = sent.sentPayloadSha256.slice(0, DIAGNOSTIC_DIGEST_PREFIX);
  const duration = diagnostic.duration_ms;
  const shape: [string, boolean][] = [
    ["event", diagnostic.event === "cross_plane_auth"],
    ["outcome", diagnostic.outcome === "accepted"],
    ["code", diagnostic.code === "OK"],
    ["reason", diagnostic.reason === "accepted"],
    ["method", diagnostic.method === sent.sentMethod],
    ["route", diagnostic.route === sent.sentRoute],
    ["kid", diagnostic.kid === KID],
    ["action", diagnostic.action === expectedAction],
    ["principal_pseudonym", diagnostic.principal_pseudonym === expectedPseudonym],
    ["payload_digest_prefix", diagnostic.payload_digest_prefix === expectedPrefix],
    ["kid_claim_state", diagnostic.kid_claim_state === "authenticated_claim"],
    ["action_claim_state", diagnostic.action_claim_state === "authenticated_claim"],
    ["payload_digest_claim_state", diagnostic.payload_digest_claim_state === "authenticated_claim"],
    ["duration_ms", typeof duration === "number" && Number.isInteger(duration) && duration >= 0],
  ];
  const wrong = shape.filter(([, held]) => !held).map(([field]) => field);
  check(
    `${assertion}__emits_an_authenticated_diagnostic`,
    parsedDiagnostic && wrong.length === 0,
    parsedDiagnostic
      ? `diagnostic fields wrong: ${wrong.join(",")}`
      : "the response carried no parseable x-s6-diagnostic record",
  );

  // An accepted request must not have reached for a cookie to get there.
  check(
    `${assertion}__consulted_no_cookie`,
    sent.cookieReads === "0",
    `x-s6-cookie-reads was ${sent.cookieReads ?? "absent"}, expected "0"`,
  );

  // The pseudonym must be a pseudonym: the raw principal id may never appear.
  check(
    `${assertion}__never_discloses_the_principal_id`,
    !`${JSON.stringify(sent.body)}${sent.diagnostic ?? ""}`.includes(PRINCIPAL_ID),
    "the raw principal id appeared in the response or diagnostic",
  );
}

interface Sent {
  status: number;
  body: Record<string, unknown>;
  cookieReads: string | null;
  diagnostic: string | null;
  /** What was actually presented, so the accepted shape is derived not assumed. */
  sentRoute: string;
  sentMethod: string;
  sentBytes: number;
  sentPayloadSha256: string;
}

/**
 * Presentation-level overrides.
 *
 * A tamper must change how an envelope is *presented*, not produce a different
 * envelope. Re-signing with an altered claim yields a new nonce, which makes the
 * refusal unusable as evidence about the original one.
 */
interface Presentation {
  extraHeaders?: Record<string, string>;
  route?: string;
  method?: string;
}

async function send(
  envelope: ServiceEnvelope,
  body: string,
  presentation: Presentation = {},
): Promise<Sent> {
  const headers = new Headers(serviceEnvelopeHeaders(envelope));
  for (const [name, value] of Object.entries(presentation.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  const response = await localFetch(`${origin}${presentation.route ?? ROUTE}`, {
    method: presentation.method ?? "POST",
    headers,
    body,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const route = presentation.route ?? ROUTE;
  const method = presentation.method ?? "POST";
  const payloadBytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", payloadBytes);
  const payloadSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    status: response.status,
    body: parsed,
    cookieReads: response.headers.get("x-s6-cookie-reads"),
    diagnostic: response.headers.get("x-s6-diagnostic"),
    sentRoute: route,
    sentMethod: method,
    sentBytes: payloadBytes.byteLength,
    sentPayloadSha256: payloadSha256,
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
      principalId: PRINCIPAL_ID,
      body,
    });

  /**
   * Restart-persistent replay.
   *
   * Every other replay assertion in this file runs against one live isolate, so
   * all of them are equally satisfied by a nonce store that never leaves memory
   * -- a `Set` on the module scope passes the whole suite. That is the failure
   * this phase exists to catch: the replay defence has to survive the process
   * that observed the first presentation.
   *
   * The launcher therefore runs this checker twice against the *same*
   * `--persist-to` directory, stopping and restarting workerd in between.
   * `persist-mint` spends one envelope and hands the exact bytes to the second
   * phase; `persist-replay` presents that same envelope to a Worker that has
   * never seen it in memory. Only a durable D1 row can refuse it.
   */
  if (PHASE === "persist-mint" || PHASE === "persist-replay") {
    const handoffPath = resolveHandoffPath(process.env.S6_STATE_DIR);
    if (!handoffPath.ok) {
      check("persist_phase_configured", false, handoffPath.detail);
      finish();
      return;
    }
    const path = handoffPath.path;

    if (PHASE === "persist-mint") {
      const body = '{"claim":"C-persist","n":7}';
      const envelope = await sign(body);
      await checkAccepted(
        "a_persisted_envelope_is_accepted_before_restart",
        await send(envelope, body),
        ACTION,
      );

      const created = writeHandoffExclusively(path, JSON.stringify({ envelope, body }));
      check(
        "the_restart_handoff_is_created_exclusively",
        created.ok,
        created.ok ? "as expected" : created.detail,
      );

      if (created.ok) {
        const written = lstatSync(path);
        check(
          "the_restart_handoff_is_a_private_regular_file",
          written.isFile() && !written.isSymbolicLink() && (written.mode & 0o077) === 0,
          `handoff mode ${(written.mode & 0o777).toString(8)}, regular ${String(written.isFile())}`,
        );
        // Structural whitelist: this file writes a credential to disk, and the
        // one thing that must never join it is key material.
        const readBack = parseHandoff(readFileSync(path, "utf8"));
        check(
          "the_restart_handoff_carries_no_key_material",
          readBack.ok,
          readBack.ok ? "as expected" : readBack.detail,
        );
      }
      finish();
      return;
    }

    // Replay phase: read back under a size bound, then validate the shape.
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(path);
    } catch {
      check("the_restart_handoff_is_readable", false, "the restart handoff is missing");
      finish();
      return;
    }
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > HANDOFF_MAX_BYTES) {
      check(
        "the_restart_handoff_is_readable",
        false,
        `the restart handoff is not a regular file within ${HANDOFF_MAX_BYTES} bytes`,
      );
      finish();
      return;
    }
    const handoff = parseHandoff(readFileSync(path, "utf8"));
    if (!handoff.ok) {
      check("the_restart_handoff_is_readable", false, handoff.detail);
      finish();
      return;
    }
    // Byte-identical to what the pre-restart Worker accepted: not re-signed,
    // not re-serialised from parts, the same envelope round-tripped.
    checkRefusal(
      "the_same_envelope_is_refused_after_a_worker_restart",
      await send(handoff.value.envelope, handoff.value.body),
    );
    finish();
    return;
  }

  // ── 1. concurrent byte-identical replay: one effect, one refusal ──────────
  {
    const body = '{"claim":"C-1","n":1}';
    const envelope = await sign(body);
    const [first, second] = await Promise.all([send(envelope, body), send(envelope, body)]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    check(
      "concurrent_identical_envelopes_yield_one_accepted_effect",
      winner.status === 200 && loser.status !== 200,
      `statuses ${first.status},${second.status}`,
    );
    await checkAccepted("the_winner_is_attributed_to_the_signed_principal", winner, ACTION);
    // The loser must be a *refusal*, not any non-200: a 500 here would mean the
    // replay store fell over, which proves nothing about the unique index.
    checkRefusal("the_loser_is_refused_not_errored", loser);
    checkRefusal("a_third_presentation_stays_refused", await send(envelope, body));
  }

  // ── 2. cookie is never consulted, and the canary never appears ────────────
  {
    const body = '{"claim":"C-2","n":2}';
    const sent = await send(await sign(body), body, {
      extraHeaders: { cookie: `__Host-authjs.session-token=${COOKIE_CANARY}` },
    });
    await checkAccepted("a_request_bearing_a_cookie_still_authenticates", sent, ACTION);
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
    // This case was misnamed and never presented a cookie: it sent
    // `envelope=1` and asserted only a 403, so "cookie on the agent host" was
    // proven by a request that contained no cookie at all.
    const envelopeOnAgent = await localFetch(
      `${origin}/__s6/principal?host=agent&route_class=agent-write&envelope=1`,
    );
    check(
      "envelope_on_the_agent_write_route_is_wrong_principal",
      envelopeOnAgent.status === 403 &&
        envelopeOnAgent.headers.get("x-s6-principal-reason") === "envelope_on_agent_route",
      `status ${envelopeOnAgent.status} reason ${String(envelopeOnAgent.headers.get("x-s6-principal-reason"))}`,
    );

    /**
     * The real cookie-on-agent probe: an actual `Cookie` header on an agent-host
     * write route, presenting no other credential.
     *
     * Two things must hold, and only a request that truly carries the cookie
     * can show either. The cookie must buy nothing — the decision is exactly
     * `no_credential`, identical to sending nothing — and it must never be
     * read, which the Worker reports through the same canary the ingress uses.
     */
    const cookieOnAgent = await localFetch(
      `${origin}/__s6/principal?host=agent&route_class=agent-write`,
      { headers: { cookie: `__Host-authjs.session-token=${COOKIE_CANARY}` } },
    );
    const cookieOnAgentBody = (await cookieOnAgent.json()) as Record<string, unknown>;
    check(
      "a_cookie_on_the_agent_write_route_is_wrong_principal",
      cookieOnAgent.status === 403 &&
        cookieOnAgentBody.code === "WRONG_PRINCIPAL" &&
        cookieOnAgent.headers.get("x-s6-principal-reason") === "no_credential",
      `status ${cookieOnAgent.status} code ${String(cookieOnAgentBody.code)} reason ${String(cookieOnAgent.headers.get("x-s6-principal-reason"))}`,
    );
    check(
      "the_principal_route_never_read_the_presented_cookie",
      cookieOnAgent.headers.get("x-s6-cookie-reads") === "0",
      `reads=${String(cookieOnAgent.headers.get("x-s6-cookie-reads"))}`,
    );
    check(
      "the_presented_cookie_is_never_echoed_by_the_principal_route",
      !`${JSON.stringify(cookieOnAgentBody)}${cookieOnAgent.headers.get("x-s6-consulted") ?? ""}`.includes(
        COOKIE_CANARY,
      ),
      "canary echoed by the principal route",
    );
    const agentConsults = await localFetch(
      `${origin}/__s6/principal?host=agent&route_class=service-envelope-worker&envelope=1`,
    );
    const consulted = agentConsults.headers.get("x-s6-consulted") ?? "";
    const consultedBody = (await agentConsults.json()) as {
      ok?: boolean;
      authenticate_with?: string;
      consulted?: string[];
    };
    const consultedList = consultedBody.consulted ?? [];
    /**
     * The positive half of the principal contract.
     *
     * Asserting only "cookie is not named" would pass against a 403, a 500, or
     * an empty body — every one of which names no cookie. The accepted case
     * must therefore be asserted as an acceptance: the right status, the right
     * credential class, and a consulted set that positively includes the
     * envelope as well as excluding the cookie.
     */
    check(
      "the_service_envelope_route_accepts_an_envelope_on_the_agent_host",
      agentConsults.status === 200 &&
        consultedBody.ok === true &&
        consultedBody.authenticate_with === "envelope",
      `status ${agentConsults.status} authenticate_with ${String(consultedBody.authenticate_with)}`,
    );
    check(
      "the_service_envelope_route_consults_the_envelope",
      consultedList.includes("envelope") && consulted.includes("envelope"),
      `consulted body [${consultedList.join(",")}] header [${consulted}]`,
    );
    check(
      "the_agent_host_never_lists_cookie_as_a_consulted_credential",
      !`${consulted}${consultedList.join(",")}`.toLowerCase().includes("cookie"),
      "cookie named as consulted",
    );
  }

  // ── 3b. planted: a server error is not a refusal ──────────────────────────
  {
    /**
     * The gate that makes every refusal assertion above mean something.
     *
     * With `status !== 200`, a Worker returning 500 satisfied every refusal
     * check in this file, so a wholly broken harness reported a clean sweep.
     * This asks the Worker for a real 500 and asserts the classifier *rejects*
     * it — the suite proving, against a live response, that it can tell a
     * refusal from a failure.
     */
    const forced = await localFetch(`${origin}/__s6/force-status?code=500`);
    const forcedBody = (await forced.json()) as Record<string, unknown>;
    check("the_harness_can_force_a_server_error", forced.status === 500, `status ${forced.status}`);
    const verdict = classifyRefusal(forced.status, forcedBody, EXPECTED_REFUSAL.unauthorized);
    check(
      "a_500_is_rejected_as_proof_of_refusal",
      !verdict.ok && verdict.detail.includes("server error"),
      `classifier accepted a 500: ${verdict.detail}`,
    );
    // And a genuine 401 with the right code is still accepted, so the guard is
    // not simply refusing everything.
    const genuine = classifyRefusal(401, { code: "UNAUTHORIZED" }, EXPECTED_REFUSAL.unauthorized);
    check("a_genuine_401_is_still_accepted", genuine.ok, genuine.detail);
  }

  // ── 4. a reordered body is refused and does NOT consume the valid nonce ───
  {
    const signedBytes = '{"claim":"C-4","n":4}';
    const reordered = '{"n":4,"claim":"C-4"}';
    const envelope = await sign(signedBytes);
    const rewritten = await send(envelope, reordered);
    checkRefusal("reordered_json_body_is_refused", rewritten);
    const honest = await send(envelope, signedBytes);
    await checkAccepted("the_refused_rewrite_did_not_consume_the_nonce", honest, ACTION);
  }

  // ── 5. every tamper is DERIVED from one envelope, which must still spend ──
  {
    /**
     * Each case mints exactly one honest envelope, derives the refused
     * presentation from that same envelope, and then presents the original
     * untouched.
     *
     * The sourcing is the whole proof. Signing a second honest envelope after
     * the refusal would demonstrate nothing: a fresh envelope carries a fresh
     * nonce, so it is accepted whether or not the refused one burned its own.
     * Only re-presenting the *same* envelope — the one whose nonce the rejected
     * request actually carried — separates a verifier that refuses before
     * consuming from one that consumes and then refuses. The second kind passes
     * every refusal assertion while quietly making honest retries impossible.
     *
     * So no case below calls `sign` twice, and no derivation re-signs.
     */
    const mutate = (
      envelope: ServiceEnvelope,
      edit: (claims: Record<string, unknown>) => void,
    ): ServiceEnvelope => {
      // A deep copy: the original must reach the second presentation untouched.
      const copy = JSON.parse(JSON.stringify(envelope)) as {
        claims: Record<string, unknown>;
        signature: string;
      };
      edit(copy.claims);
      return copy as unknown as ServiceEnvelope;
    };

    interface Tamper {
      assertion: string;
      body: string;
      derive: (envelope: ServiceEnvelope, body: string) => Promise<Sent>;
    }

    const tampers: Tamper[] = [
      {
        assertion: "the_same_envelope_presented_on_another_route_is_refused",
        body: '{"claim":"C-5","n":51}',
        // Presented, not re-signed: the alias mount runs the identical verifier,
        // so the refusal can only come from the route binding.
        derive: (envelope, body) => send(envelope, body, { route: ALIAS_ROUTE }),
      },
      {
        assertion: "the_same_envelope_presented_with_another_method_is_refused",
        body: '{"claim":"C-5","n":52}',
        derive: (envelope, body) => send(envelope, body, { method: "PUT" }),
      },
      {
        assertion: "the_same_envelope_with_a_rewritten_action_is_refused",
        body: '{"claim":"C-5","n":53}',
        derive: (envelope, body) =>
          send(
            mutate(envelope, (claims) => {
              claims.action = "s6.other";
            }),
            body,
          ),
      },
      {
        assertion: "the_same_envelope_with_rewritten_timestamps_is_refused",
        body: '{"claim":"C-5","n":54}',
        derive: (envelope, body) =>
          send(
            mutate(envelope, (claims) => {
              claims.iat = NOW - 86_400;
              claims.exp = NOW - 86_000;
            }),
            body,
          ),
      },
      {
        assertion: "the_same_envelope_with_a_flipped_signature_is_refused",
        body: '{"claim":"C-5","n":55}',
        derive: (envelope, body) => {
          const copy = JSON.parse(JSON.stringify(envelope)) as {
            claims: Record<string, unknown>;
            signature: string;
          };
          const signature = copy.signature;
          copy.signature = `${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "AB" : "AA"}`;
          return send(copy as unknown as ServiceEnvelope, body);
        },
      },
      {
        assertion: "the_same_envelope_with_an_unknown_kid_is_refused",
        body: '{"claim":"C-5","n":56}',
        // `kid` lives inside the signed claims. Setting a top-level `kid` would
        // leave `claims.kid` intact and the envelope perfectly valid, so that
        // spelling would assert nothing at all.
        derive: (envelope, body) =>
          send(
            mutate(envelope, (claims) => {
              claims.kid = "s6-not-in-keyring";
            }),
            body,
          ),
      },
      {
        assertion: "the_same_envelope_with_an_altered_payload_is_refused",
        body: '{"claim":"C-5","n":57}',
        derive: (envelope, _body) => send(envelope, '{"claim":"C-5","n":999}'),
      },
    ];

    for (const tamper of tampers) {
      const envelope = await sign(tamper.body);
      // Exactly 401/UNAUTHORIZED. A 500 is a broken harness, not a refusal.
      checkRefusal(tamper.assertion, await tamper.derive(envelope, tamper.body));
      // …and the very envelope that was just rejected must still be spendable.
      await checkAccepted(
        `${tamper.assertion.replace(/_is_refused$/, "")}__left_the_original_envelope_spendable`,
        await send(envelope, tamper.body),
        ACTION,
      );
    }
  }

  // ── 5b. a genuinely expired envelope is refused ───────────────────────────
  {
    // Signed with an old clock rather than rewritten, so this exercises the
    // expiry comparison itself. It is deliberately *not* paired with a
    // re-presentation: an expired envelope is expired on the second showing
    // too, so it can carry no nonce-order claim.
    const body = '{"claim":"C-5b","n":58}';
    checkRefusal(
      "a_genuinely_expired_envelope_is_refused",
      await send(await sign(body, { now: NOW - 86_400 }), body),
    );
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

  finish();
}

if (import.meta.main) await main();
