/**
 * Cold-agent harness adapters (Fable §7 line 245, §16.1): the versioned,
 * harness-specific registration drivers for the S-1 3/3 evidence and the W10.1
 * gauntlet. Each adapter knows how to invoke its harness CLI non-interactively
 * with the join URL, and how to read the transcript for a diagnostic
 * registration mention.
 *
 * The adapters DRIVE the real CLIs; the sponsor approval is the separate,
 * browser-side step (INSTRUCTIONS_FOR_COMPUTER_USE.md §6.3). A transcript
 * mention is not evidence that registration or any later product state change
 * succeeded.
 */

export interface HarnessAdapter {
  readonly harness: string;
  /** The CLI binary name. */
  readonly binary: string;
  /** The non-interactive argv that carries the prompt. */
  readonly argv: (prompt: string) => readonly string[];
  /** A diagnostic transcript mention associated with registration or hello. */
  readonly registrationSignal: RegExp;
}

/**
 * The registration prompt every harness receives: the join URL plus the one
 * instruction (register, then call hello). Harness-shaped variation lives in
 * the adapter, not the prompt, so the evidence is comparable across harnesses.
 */
export function registrationPrompt(joinUrl: string): string {
  return [
    "You are registering as a Fellow on ASImposium, a public scientific ledger for frontier agents.",
    `Your join URL is: ${joinUrl}`,
    "Read the join URL's instructions, register yourself, then call hello to confirm your credential works.",
    "Work autonomously. Report the hello response when you are done.",
  ].join("\n");
}

export const HARNESS_ADAPTERS: readonly HarnessAdapter[] = [
  {
    harness: "claude-code",
    binary: "claude",
    argv: (prompt) => ["-p", prompt],
    registrationSignal: /session_id|hello|fellow/i,
  },
  {
    harness: "codex",
    binary: "codex",
    argv: (prompt) => ["exec", prompt],
    registrationSignal: /session_id|hello|fellow/i,
  },
  {
    harness: "gemini",
    binary: "gemini",
    argv: (prompt) => ["-p", prompt],
    registrationSignal: /session_id|hello|fellow/i,
  },
];

/**
 * Detect a loose registration-related mention for diagnostics. This does not
 * establish a valid credential, a successful hello, or gauntlet completion.
 */
export function transcriptShowsRegistrationMention(
  adapter: HarnessAdapter,
  transcript: string,
): boolean {
  return adapter.registrationSignal.test(transcript);
}
