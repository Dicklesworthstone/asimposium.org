import { DirectiveDisclosureTargetSchema } from "@asimposium/contracts/directive-disclosures";
import { isTrustedStoaOrigin } from "@asimposium/contracts";

const TargetIdentitySchema = DirectiveDisclosureTargetSchema.pick({
  problem_id: true, claim_id: true, version: true,
});

/** Navigation selects one immutable claim version; it never grants authority. */
export interface DirectiveDisclosureTarget {
  readonly problemId: string;
  readonly claimId: string;
  readonly version: number;
}

export type DirectiveDisclosureSelection =
  | { readonly state: "empty" }
  | { readonly state: "invalid" }
  | { readonly state: "selected"; readonly target: DirectiveDisclosureTarget };

export function isDirectiveDisclosureTarget(value: unknown): value is DirectiveDisclosureTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return Object.keys(target).length === 3 &&
    Object.keys(target).every((key) => ["problemId", "claimId", "version"].includes(key)) &&
    typeof target.problemId === "string" && target.problemId.trim() === target.problemId &&
    typeof target.claimId === "string" && target.claimId.trim() === target.claimId &&
    TargetIdentitySchema.safeParse({
      problem_id: target.problemId, claim_id: target.claimId, version: target.version,
    }).success;
}

export function directiveDisclosureSelection(
  query: Readonly<Record<string, string | string[] | undefined>>,
): DirectiveDisclosureSelection {
  const keys = Object.keys(query);
  if (keys.length === 0) return { state: "empty" };
  if (keys.some((key) => !["problem", "claim", "version"].includes(key))) {
    return { state: "invalid" };
  }
  if (typeof query.version !== "string" || !/^[1-9][0-9]*$/.test(query.version) ||
      query.version.trim() !== query.version) return { state: "invalid" };
  const target = { problemId: query.problem, claimId: query.claim, version: Number(query.version) };
  return isDirectiveDisclosureTarget(target)
    ? { state: "selected", target }
    : { state: "invalid" };
}

export function directiveDisclosureHref(target?: DirectiveDisclosureTarget): string {
  if (!isDirectiveDisclosureTarget(target)) return "/console/disclosures";
  return `/console/disclosures?${new URLSearchParams({
    problem: target.problemId,
    claim: target.claimId,
    version: String(target.version),
  })}`;
}

export function directiveDisclosureClaimHref(target: DirectiveDisclosureTarget): string {
  if (!isDirectiveDisclosureTarget(target)) return "/console/disclosures";
  return `/p/${encodeURIComponent(target.problemId)}/claims/${encodeURIComponent(`${target.claimId}@${target.version}`)}`;
}

/** Link to this deployment's canonical public declaration, with no production fallback. */
export function directiveDisclosureDocumentHref(
  target: DirectiveDisclosureTarget,
  eventId: string,
  stoaOrigin: string | undefined,
): string | null {
  if (!isDirectiveDisclosureTarget(target) || !isTrustedStoaOrigin(stoaOrigin) ||
      /^DD-[a-f0-9]{32}$/.exec(eventId)?.[0] !== eventId) return null;
  return `${stoaOrigin}/p/${encodeURIComponent(target.problemId)}/disclosures/${eventId}.md`;
}
