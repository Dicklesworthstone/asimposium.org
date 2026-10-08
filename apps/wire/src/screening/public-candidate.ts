/**
 * P7/A9 (beads asimposiumorg-b9y9 / asimposiumorg-kqz5): the one public-content
 * screening decision boundary, shared by every route that makes Fellow text
 * public: session ledger writes and sponsor problem publication.
 *
 * Outcome mapping:
 * - provider failure and incoherent tuples hold, failing closed;
 * - reject denies with only a coarse category plus the appeal path;
 * - quarantine and allow-with-warning hold, because their public-notice
 *   projection has not landed;
 * - only the coherent benign pass tuple publishes, bound to the exact
 *   candidate bytes by its attested digests.
 * Policy refusals starve the oracle (A5): no pattern names, no model output.
 */

import {
  SCREENING_APPEAL_CODE,
  type ScreeningCoarseCategory,
  ScreeningCoarseCategorySchema,
  ScreeningOutcomeSchema,
  ScreeningPromotionDeniedResponseSchema,
  ScreeningPromotionHoldResponseSchema,
  ScreeningProviderStatusSchema,
  ScreeningPublicActionSchema,
} from "@asimposium/contracts";
import type { Env } from "../env";
import { postureOf, recordRefusal } from "../moderation/posture";
import {
  openScreeningCase,
  type ScreeningCaseRow,
  screeningCaseFor,
  supersedePendingCase,
} from "../moderation/store";
import { scanFieldsForCredentials, secretShapedContentProblem } from "./credential-scan";
import {
  publicationProvenance,
  releasedPublicationProvenance,
  type ScreenedPublication,
} from "./ingress";
import {
  type PublicationScreeningObservation,
  promotionScreeningBinding,
  type WorkersAIPromotionInput,
} from "./workers-ai";

export type PublicCandidateScreener = (
  input: WorkersAIPromotionInput,
  env: Env,
) => Promise<PublicationScreeningObservation>;

function privateNoStore(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

export function screeningHoldResponse(
  category: ScreeningCoarseCategory,
  caseId?: string,
  posture?: "quarantine-first",
): Response {
  return privateNoStore(
    ScreeningPromotionHoldResponseSchema.parse({
      code: "SCREENING_HOLD",
      // A posture hold never reveals what the screen said (2i3s).
      ...(posture === undefined ? { coarse_category: category } : { posture }),
      appeal: SCREENING_APPEAL_CODE,
      ...(caseId === undefined ? {} : { case_id: caseId }),
    }),
    202,
  );
}

/**
 * Who is asking, for the private review case a hold opens. Without it (a
 * caller that cannot attribute the write) a hold still holds, but no case is
 * opened, exactly as before the moderation plane existed.
 */
export interface ScreeningHoldContext {
  readonly sponsorId: string;
  readonly route: string;
}

const HEX64 = /^[a-f0-9]{64}$/;

function hex64(value: string | undefined, fallbackLabel: string): Promise<string> | string {
  const bare = value?.startsWith("sha256:") ? value.slice(7) : value;
  if (bare !== undefined && HEX64.test(bare)) return bare;
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(fallbackLabel))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function versionLabel(value: string | undefined): string {
  return value !== undefined && VERSION_LABEL.test(value) && value.length <= 128
    ? value
    : "unavailable";
}

/**
 * Hold, and keep the work: open (or find) the private case for exactly these
 * bytes so a trained reviewer can release or reject it (Fable §7.7: "legitimate
 * work waits rather than vanishes"). Case storage failing never turns a hold
 * into a publication; it only loses the case id from the response.
 */
async function holdWithCase(
  env: Env,
  input: WorkersAIPromotionInput,
  context: ScreeningHoldContext | undefined,
  category: ScreeningCoarseCategory,
  outcome: "quarantine" | "allow-with-warning" | "provider-unavailable",
  observation: Partial<PublicationScreeningObservation> | undefined,
  posture?: "quarantine-first",
): Promise<Response> {
  if (context === undefined || env.DB === undefined) {
    return screeningHoldResponse(category, undefined, posture);
  }
  try {
    const binding = await promotionScreeningBinding(input);
    const opened = await openScreeningCase(env.DB, {
      problemId: input.problemId,
      fellowId: input.fellowId,
      sponsorId: context.sponsorId,
      route: context.route,
      inputDigest: binding.bodyDigest.slice(7),
      contextDigest: binding.contextDigest.slice(7),
      candidate: { kind: input.kind, statement: input.statement, falsifier: input.falsifier },
      coarseCategory: category,
      // The public log must not reveal the screen's verdict for a posture hold.
      ...(posture === undefined ? {} : { logCategory: "author-posture" }),
      outcome,
      decisionPath: versionLabel(observation?.decision_path),
      providerStatus: versionLabel(observation?.provider_status),
      modelVersion: versionLabel(observation?.model_version),
      policyVersion: versionLabel(observation?.policy_version),
      configurationDigest: await hex64(
        observation?.configuration_digest,
        "configuration-unavailable",
      ),
    });
    return screeningHoldResponse(category, opened.caseId, posture);
  } catch {
    return screeningHoldResponse(category, undefined, posture);
  }
}

/**
 * Fable §9.1 graduated posture: a content refusal (never a provider fault)
 * counts toward this Fellow's quarantine-first threshold. Recording failure
 * never changes the refusal itself.
 */
async function noteRefusal(
  env: Env,
  input: WorkersAIPromotionInput,
  context: ScreeningHoldContext | undefined,
  outcome: "reject" | "quarantine",
  category: ScreeningCoarseCategory,
): Promise<void> {
  if (context === undefined || env.DB === undefined || category === "provider-unavailable") return;
  try {
    const binding = await promotionScreeningBinding(input);
    await recordRefusal(env.DB, {
      fellowId: input.fellowId,
      sponsorId: context.sponsorId,
      problemId: input.problemId,
      outcome,
      coarseCategory: category,
      inputDigest: binding.bodyDigest.slice(7),
    });
  } catch {
    // The refusal stands whether or not it could be counted.
  }
}

/** Whether this Fellow's public writes currently wait for review first. */
async function quarantineFirst(
  env: Env,
  input: WorkersAIPromotionInput,
  context: ScreeningHoldContext | undefined,
): Promise<boolean> {
  if (context === undefined || env.DB === undefined) return false;
  try {
    return (await postureOf(env.DB, input.fellowId)).quarantineFirst;
  } catch {
    return false;
  }
}

/** A decided case for exactly these bytes, if the store can be read. */
async function decidedCase(
  env: Env,
  input: WorkersAIPromotionInput,
): Promise<ScreeningCaseRow | undefined> {
  if (env.DB === undefined) return undefined;
  try {
    const binding = await promotionScreeningBinding(input);
    return await screeningCaseFor(
      env.DB,
      input.fellowId,
      input.problemId,
      binding.bodyDigest.slice(7),
    );
  } catch {
    return undefined;
  }
}

function screeningDeniedResponse(category: ScreeningCoarseCategory): Response | undefined {
  const parsed = ScreeningPromotionDeniedResponseSchema.safeParse({
    code: "POLICY_DENIED",
    coarse_category: category,
    appeal: SCREENING_APPEAL_CODE,
  });
  return parsed.success ? privateNoStore(parsed.data, 403) : undefined;
}

/** Screen one exact public candidate. Returns private provenance to retain,
 * or the hold/deny response the route must return instead of committing. */
export async function screenPublicCandidate(
  screener: PublicCandidateScreener,
  env: Env,
  candidate: WorkersAIPromotionInput,
  holdContext?: ScreeningHoldContext,
): Promise<Response | ScreenedPublication> {
  // The adapter cannot mutate a candidate after the route has validated it.
  const input = Object.freeze({ ...candidate });
  // §9.1/§10.4 (P7): credential-shaped runs never reach a provider, a public
  // event, or a projection. Deterministic, so it runs before the model.
  const secrets = scanFieldsForCredentials({
    statement: input.statement,
    falsifier: input.falsifier,
  });
  if (secrets.length > 0) return secretShapedContentProblem(secrets);

  // A reviewer's decision on exactly these bytes, by this author, on this
  // problem, binds: a release publishes them without re-asking the model; a
  // confirmed rejection refuses them with the same starved policy face.
  const decided = await decidedCase(env, input);
  if (decided?.state === "released") {
    try {
      return await releasedPublicationProvenance(input, {
        caseId: decided.case_id,
        inputDigest: decided.input_digest,
        contextDigest: decided.context_digest,
        modelVersion: decided.model_version,
        policyVersion: decided.policy_version,
        configurationDigest: decided.configuration_digest,
      });
    } catch {
      return screeningHoldResponse("provider-unavailable", decided.case_id);
    }
  }
  if (decided?.state === "rejected") {
    const category = ScreeningCoarseCategorySchema.safeParse(decided.coarse_category);
    return (
      (category.success ? screeningDeniedResponse(category.data) : undefined) ??
      screeningHoldResponse("provider-unavailable", decided.case_id)
    );
  }
  let screening: PublicationScreeningObservation;
  try {
    const raw = await screener(input, env);
    const decision = ScreeningOutcomeSchema.safeParse(raw.decision);
    const category = ScreeningCoarseCategorySchema.safeParse(raw.coarse_category);
    const providerStatus = ScreeningProviderStatusSchema.safeParse(raw.provider_status);
    if (!decision.success || !category.success || !providerStatus.success) {
      return holdWithCase(
        env,
        input,
        holdContext,
        "provider-unavailable",
        "provider-unavailable",
        undefined,
      );
    }
    screening = {
      ...raw,
      decision: decision.data,
      coarse_category: category.data,
      provider_status: providerStatus.data,
    };
  } catch {
    return holdWithCase(
      env,
      input,
      holdContext,
      "provider-unavailable",
      "provider-unavailable",
      undefined,
    );
  }
  if (screening.provider_status !== "ok") {
    return holdWithCase(
      env,
      input,
      holdContext,
      "provider-unavailable",
      "provider-unavailable",
      screening,
    );
  }
  if (screening.decision === "reject") {
    await noteRefusal(env, input, holdContext, "reject", screening.coarse_category);
    return (
      screeningDeniedResponse(screening.coarse_category) ??
      screeningHoldResponse("provider-unavailable")
    );
  }
  if (screening.decision === "quarantine" || screening.decision === "allow-with-warning") {
    if (screening.decision === "quarantine") {
      await noteRefusal(env, input, holdContext, "quarantine", screening.coarse_category);
    }
    if (await quarantineFirst(env, input, holdContext)) {
      return holdWithCase(
        env,
        input,
        holdContext,
        screening.coarse_category,
        screening.decision,
        screening,
        "quarantine-first",
      );
    }
    return holdWithCase(
      env,
      input,
      holdContext,
      screening.coarse_category,
      screening.decision,
      screening,
    );
  }
  if (
    !ScreeningPublicActionSchema.safeParse({
      category: screening.coarse_category,
      action: "published",
      notice: "none",
    }).success
  ) {
    // An incoherent provider tuple is a provider fault: the work waits.
    return holdWithCase(
      env,
      input,
      holdContext,
      "provider-unavailable",
      "provider-unavailable",
      screening,
    );
  }
  try {
    const published = await publicationProvenance(input, screening);
    // Quarantine-first: a Fellow past its refusal threshold waits for a
    // human even when the screen passes. Its pending case (if any) stays open.
    if (await quarantineFirst(env, input, holdContext)) {
      return holdWithCase(
        env,
        input,
        holdContext,
        screening.coarse_category,
        "quarantine",
        screening,
        "quarantine-first",
      );
    }
    if (decided?.state === "pending" && env.DB !== undefined) {
      // A clean screen of the same bytes makes the earlier hold moot.
      await supersedePendingCase(
        env.DB,
        input.fellowId,
        input.problemId,
        decided.input_digest,
      ).catch(() => undefined);
    }
    return published;
  } catch {
    // An attestation that does not bind these bytes is a provider fault too.
    return holdWithCase(
      env,
      input,
      holdContext,
      "provider-unavailable",
      "provider-unavailable",
      screening,
    );
  }
}
