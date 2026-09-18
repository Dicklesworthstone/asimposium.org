import type { PublicationScreenResult } from "./artifact-publication-outbox.ts";

/** Independent provider ingress bound. Never truncate a body to fit a model:
 * a prefix verdict cannot authorize the digest of an entire source archive. */
export const PUBLICATION_SCREEN_BYTES = 64 * 1024;
export const PUBLICATION_SCREEN_TIMEOUT_MS = 12_000;
export interface PublicationScreenIdentity {
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
}
export interface BoundPublicationScreen {
  readonly body: string;
  readonly body_digest: string;
  readonly context_digest: string;
  readonly identity: PublicationScreenIdentity;
}
export type PublicationPolicyCall = (
  input: BoundPublicationScreen,
  signal: AbortSignal,
) => Promise<unknown>;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const categories = new Set([
  "benign-context",
  "spam-commercial",
  "injection",
  "dual-use-boundary",
  "operational-harm",
  "harassment",
  "sexual-content",
]);
const decisions = new Set(["pass", "allow-with-warning", "quarantine", "reject"]);

/** Execute one digest-bound live-provider call, with no persistence, logs or
 * fallback pass. The composition root supplies WorkersAIScreeningProvider;
 * that adapter still owns model-response JSON and score-band validation. */
export async function screenBoundArtifact(
  input: BoundPublicationScreen,
  invoke: PublicationPolicyCall,
  timeoutMs = PUBLICATION_SCREEN_TIMEOUT_MS,
): Promise<PublicationScreenResult> {
  const { body, body_digest, context_digest } = input;
  const { model_version, policy_version, configuration_digest } = input.identity;
  const bytes = new TextEncoder().encode(body);
  if (
    typeof body !== "string" ||
    bytes.length < 1 ||
    bytes.length > PUBLICATION_SCREEN_BYTES ||
    !digestPattern.test(body_digest) ||
    !digestPattern.test(context_digest) ||
    !digestPattern.test(configuration_digest) ||
    !labelPattern.test(model_version) ||
    !labelPattern.test(policy_version) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > PUBLICATION_SCREEN_TIMEOUT_MS
  )
    throw new Error("ARTIFACT_SCREEN_INPUT_INVALID");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (`sha256:${Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("")}` !== body_digest)
    throw new Error("ARTIFACT_SCREEN_INPUT_INVALID");
  // Freeze a fresh value, not the caller's mutable job/inspection object.
  const bound = Object.freeze({
    body,
    body_digest,
    context_digest,
    identity: Object.freeze({ model_version, policy_version, configuration_digest }),
  });
  const identity = {
    evaluated_body_digest: body_digest,
    evaluated_context_digest: context_digest,
    model_version,
    policy_version,
    configuration_digest,
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("ARTIFACT_SCREEN_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const observed = await Promise.race([
      Promise.resolve().then(() => invoke(bound, controller.signal)),
      deadline,
    ]);
    if (controller.signal.aborted) throw new Error("ARTIFACT_SCREEN_TIMEOUT");
    if (
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      !("decision" in observed) ||
      typeof observed.decision !== "string" ||
      !decisions.has(observed.decision) ||
      !("coarse_category" in observed) ||
      typeof observed.coarse_category !== "string" ||
      !categories.has(observed.coarse_category)
    )
      throw new Error("ARTIFACT_SCREEN_RESULT_INVALID");
    return {
      ...identity,
      decision: observed.decision as PublicationScreenResult["decision"],
      coarse_category: observed.coarse_category,
      provider_status: "ok",
    };
  } catch {
    return {
      ...identity,
      decision: "quarantine",
      coarse_category: "provider-unavailable",
      provider_status: controller.signal.aborted ? "timeout" : "error",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
