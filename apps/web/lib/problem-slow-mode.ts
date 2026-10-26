import "server-only";

import { PROBLEM_SLOW_MODE_STEP_UP_SECONDS } from "@asimposium/contracts";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "./sponsor-id";
import { operatorPrincipalIsAllowed } from "./stoa";

export type SlowModeAudience = "operator" | "sponsor";

/** Match this command's Worker gate exactly, including future-time refusal. */
export function slowModeAuthIsRecent(
  issuedAt: number | undefined,
  now = Math.floor(Date.now() / 1_000),
): issuedAt is number {
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt >= 0 &&
    Number.isSafeInteger(now) && now >= issuedAt &&
    now - issuedAt <= PROBLEM_SLOW_MODE_STEP_UP_SECONDS;
}

/** Identity and authority are resolved again for every read or mutation. */
export async function problemSlowModeSession(audience: SlowModeAudience) {
  if (audience !== "operator" && audience !== "sponsor") {
    return { state: "forbidden" as const };
  }
  const session = await auth();
  const principalId = session?.user?.id;
  if (!isCanonicalSponsorId(principalId)) {
    return { state: "unauthenticated" as const };
  }
  if (audience === "operator" && !operatorPrincipalIsAllowed(principalId)) {
    return { state: "forbidden" as const };
  }
  return {
    state: "authorized" as const,
    principalId,
    authIssuedAt: session?.authIssuedAt,
  };
}
