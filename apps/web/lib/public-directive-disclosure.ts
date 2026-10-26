import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type SponsorDirectiveDisclosureReceipt,
  SponsorDirectiveDisclosureReceiptSchema,
} from "@asimposium/contracts/directive-disclosures";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

export interface PublicDisclosureTarget {
  readonly problemId: string;
  readonly eventId: string;
  readonly humanPath: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

/** A public receipt selector cannot become an arbitrary Worker path or origin. */
export function publicDisclosureTarget(
  problemId: unknown,
  eventId: unknown,
): PublicDisclosureTarget | null {
  if (typeof problemId !== "string" || typeof eventId !== "string" ||
      !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
      /^DD-[a-f0-9]{32}$/.exec(eventId)?.[0] !== eventId) return null;
  const path = `/p/${encodeURIComponent(problemId)}/disclosures/${eventId}`;
  return { problemId, eventId, humanPath: path, jsonPath: `${path}.json`, markdownPath: `${path}.md` };
}

/** Current visibility is checked on every request, even for an immutable receipt. */
export async function stoaFetchPublicDirectiveDisclosure(
  problemId: string,
  eventId: string,
  origin: string | undefined = configuredStoaOrigin(),
): Promise<PublicRead<SponsorDirectiveDisclosureReceipt>> {
  const target = publicDisclosureTarget(problemId, eventId);
  if (target === null) return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    target.jsonPath,
    origin,
    SponsorDirectiveDisclosureReceiptSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state !== "ok") return result;
  return result.data.target.problem_id === target.problemId && result.data.event_id === target.eventId &&
    result.data.seq > result.data.target.publication_seq
    ? result
    : { state: "unavailable", reason: "invalid_response" };
}
