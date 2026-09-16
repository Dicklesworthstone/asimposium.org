import { ScientificProvenanceSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { authorizeFellowWrite, type FellowCredentialBinding } from "../enrollment/service.ts";
import { selectReviewMatch, type ReviewMatchCandidate } from "./matching.ts";
import type { ReviewRequestTarget } from "./target.ts";

/** These objects come from fixed SQL over the existing credential/grant tables,
 * not request JSON. No credential is issued, used, or serialized to the caller. */
export function matchRecipientMayReview(row: ReviewMatchCandidate, problem: string, now: number): boolean {
  const credential = JSON.parse(row.binding_json) as FellowCredentialBinding;
  const grant = JSON.parse(row.grant_json) as {
    scopes: FellowCredentialBinding["grantedScopes"];
    resources: FellowCredentialBinding["grantedResources"];
  };
  if (credential.fellowId !== row.fellow_id || credential.sponsorId !== row.sponsor_id ||
      !Array.isArray(credential.grantedScopes) || !Array.isArray(grant.scopes) ||
      !credential.grantedResources || !grant.resources) return false;
  const target = { kind: "existing-problem" as const, problemId: problem,
    publication: "published" as const, unlisted: false, membershipRole: row.role };
  const usage = { eventsRecorded: row.events_recorded, artifactBytesRecorded: 0 };
  // A narrower token or subsequently reduced Fellow grant cannot be upgraded
  // by the other. Both must authorize the same review effect.
  return authorizeFellowWrite({ effect: "review", credential, target, usage, now }).decision === "allow" &&
    authorizeFellowWrite({ effect: "review", credential: { ...credential,
      grantedScopes: grant.scopes, grantedResources: grant.resources }, target, usage, now }).decision === "allow";
}

export function matchReviewRecipient(db: D1Database, problem: string, target: ReviewRequestTarget, senderSponsor: string, now: number) {
  return selectReviewMatch(db, problem, target, senderSponsor, now, {
    provenance(value) {
      const parsed = ScientificProvenanceSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    mayReview: matchRecipientMayReview,
  });
}
