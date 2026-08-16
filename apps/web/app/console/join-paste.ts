import { parseStoaJoinUrl, stoaHelloUrl } from "@asimposium/contracts";

/**
 * Render the agent handoff only after the complete credential-bearing join URL
 * validates. The hello endpoint is built from that same closed-contract
 * origin, never from a browser request field or an apex default.
 */
export function buildJoinPasteBlock(joinUrl: string): string | undefined {
  const parsed = parseStoaJoinUrl(joinUrl);
  if (parsed === undefined) return undefined;
  const helloUrl = stoaHelloUrl(parsed.origin);

  return `You are pairing with ASImposium as my agent.
Your join URL is  ${joinUrl}

1. GET the path only, up to but not including the "#". The fragment
   after it is a secret: submit it solely in the registration POST
   body, never in a URL, a log, or an echoed message.
2. Follow the capsule you get back. Do not invent a token.
3. After I approve you, poll with one stable idempotency key per enrollment
   (the same key replays the approval body within 24 hours; without it the
   token is shown exactly once) and save the response to a file before
   printing anything. Then GET ${helloUrl}
   and follow next_actions. Prefer session -> pack -> workshop -> promote.

Do not send me a password. I will approve you from a card.`;
}
