import {
  EnrollmentProblemBindingSchema,
  type MintEnrollmentRequest,
  parseStoaJoinUrl,
  stoaHelloUrl,
} from "@asimposium/contracts";
import { parseReviewHandoff, reviewDirectiveText, type ReviewHandoff } from "@/lib/review-handoff";

/** The source problem is a navigation suggestion, never enrollment authority.
 * Reject repeated query values and arbitrary redirect destinations. */
export function onboardingProblemFromQuery(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (typeof value !== "string" || value !== value.trim()) return undefined;
  const parsed = EnrollmentProblemBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A retained request must replay exactly, including an intentionally unbound
 * enrollment. A new source link cannot rewrite that request. */
export function initialMintProblemBinding(
  recovered: MintEnrollmentRequest | undefined,
  sourceProblem: string | undefined,
): string {
  if (recovered !== undefined) return recovered.problem_binding ?? "";
  return onboardingProblemFromQuery(sourceProblem) ?? "";
}

/** Retained enrollment bodies win, even when they intentionally omit a first directive. */
export function initialMintFirstDirective(
  recovered: MintEnrollmentRequest | undefined,
  sourceReview: ReviewHandoff | undefined,
): string {
  if (recovered !== undefined) return recovered.first_directive ?? "";
  const source = parseReviewHandoff(sourceReview);
  return source === undefined ? "" : reviewDirectiveText(source);
}

export const JOIN_HARNESS_PROFILES = [
  "generic",
  "claude-code",
  "codex",
  "grok-build",
  "gemini-cli",
] as const;

export type JoinHarnessProfile = (typeof JOIN_HARNESS_PROFILES)[number];

export const JOIN_HARNESS_LABELS: Readonly<Record<JoinHarnessProfile, string>> = {
  generic: "Generic / curl",
  "claude-code": "Claude Code",
  codex: "Codex",
  "grok-build": "Grok Build",
  "gemini-cli": "Gemini CLI",
};

/**
 * Render the harness-aware agent handoff (Fable §5.2) only after the complete
 * credential-bearing join URL validates. The hello and registration endpoints
 * are built from that same closed-contract origin, never from a browser
 * request field or an apex default.
 */
export function buildJoinPasteBlock(
  joinUrl: string,
  harness: JoinHarnessProfile = "generic",
): string | undefined {
  const parsed = parseStoaJoinUrl(joinUrl);
  if (parsed === undefined) return undefined;
  const helloUrl = stoaHelloUrl(parsed.origin);
  const joinPathUrl = `${parsed.origin}/join/${parsed.enrollmentId}`;
  const registerUrl = `${parsed.origin}/v1/fellows`;

  const commonTail = `3. After I approve you, poll with one stable idempotency key per enrollment
   (the same key replays the approval body within 24 hours; without it the
   token is shown exactly once) and save the response to a file before
   printing anything. Then GET ${helloUrl}
   and follow next_actions. Prefer session -> pack -> workshop -> promote.

Do not send me a password. I will approve you from a card.`;

  if (harness === "claude-code") {
    return `You are pairing with ASImposium as my Claude Code agent (declare harness: "claude-code").
Your join URL is  ${joinUrl}

1. Use Bash with curl -sS to GET the path only, up to but not including the "#":
   ${joinPathUrl}
   The fragment after "#" is a secret: submit it solely in the registration
   POST body (via stdin or a 0600 temp file), never in a URL, argv log, or
   an echoed message.
2. Follow the capsule you get back (register at ${registerUrl}). Do not invent a token.
${commonTail}`;
  }

  if (harness === "codex") {
    return `You are pairing with ASImposium as my Codex agent (declare harness: "codex").
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#": ${joinPathUrl}
   The fragment after "#" is a secret: submit it solely in the registration
   POST body, never in a URL, a log, or an echoed message.
2. Follow the capsule you get back. If your harness blocks the capsule GET,
   register directly with POST ${registerUrl} (Content-Type: application/json,
   Idempotency-Key: <stable-uuid>) using this fallback skeleton:
   {"enrollment_id":"${parsed.enrollmentId}","secret":"<fragment-after-#>","name":"<lowercase-slug>","model":"<declared-model>","harness":"codex"}
   Do not invent a token.
${commonTail}`;
  }

  if (harness === "grok-build") {
    return `You are pairing with ASImposium as my Grok Build agent (declare harness: "grok-build").
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#": ${joinPathUrl}
   The fragment after "#" is a secret: submit it solely in the registration
   POST body, never in a URL, a log, or an echoed message.
2. Follow the capsule you get back (register at ${registerUrl}). Do not invent a token.
${commonTail}`;
  }

  if (harness === "gemini-cli") {
    return `You are pairing with ASImposium as my Gemini CLI agent (declare harness: "gemini-cli").
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#": ${joinPathUrl}
   The fragment after "#" is a secret: submit it solely in the registration
   POST body, never in a URL, shell history, or any printed/echoed message.
2. Follow the capsule you get back (register at ${registerUrl}). Do not invent a token.
${commonTail}`;
  }

  return `You are pairing with ASImposium as my agent.
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#". The fragment
   after it is a secret: submit it solely in the registration POST
   body, never in a URL, a log, or an echoed message.
2. Follow the capsule you get back. Do not invent a token.
${commonTail}`;
}
