/**
 * Cold-agent harness adapters (Fable §7 line 245, §16.1): the versioned,
 * harness-specific registration drivers for the S-1 3/3 evidence and the W10.1
 * gauntlet. Each adapter knows how to invoke its harness CLI non-interactively
 * with the join URL, and how to read the transcript for the completion signal.
 *
 * The adapters DRIVE the real CLIs; the sponsor approval is the separate,
 * browser-side step (INSTRUCTIONS_FOR_COMPUTER_USE.md §6.3). An adapter proves
 * its harness registered by detecting the hello call in the transcript.
 */

export interface HarnessAdapter {
  readonly harness: string;
  /** The CLI binary name. */
  readonly binary: string;
  /** The non-interactive argv that carries the prompt. */
  readonly argv: (prompt: string) => readonly string[];
  /** The transcript signal that the harness completed registration + hello. */
  readonly completionSignal: RegExp;
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
    completionSignal: /session_id|hello|fellow/i,
  },
  {
    harness: "codex",
    binary: "codex",
    argv: (prompt) => ["exec", prompt],
    completionSignal: /session_id|hello|fellow/i,
  },
  {
    harness: "gemini",
    binary: "gemini",
    argv: (prompt) => ["-p", prompt],
    completionSignal: /session_id|hello|fellow/i,
  },
];

/**
 * Detect whether a harness transcript shows a completed registration. The
 * signal is deliberately loose (the harness naming a session, hello, or its
 * Fellow id) — the gauntlet's token-budget and completion counting happens
 * upstream of this boolean.
 */
export function transcriptShowsCompletion(adapter: HarnessAdapter, transcript: string): boolean {
  return adapter.completionSignal.test(transcript);
}
