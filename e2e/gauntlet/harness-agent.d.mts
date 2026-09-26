/** Types for harness-agent.mjs (the runner is plain Node ESM; tests are TypeScript). */
export interface HarnessSpec {
  readonly binary: string;
  argv(prompt: string): string[];
  tokens(stdout: string): unknown;
  unavailable(stdout: string, stderr: string): "usage-limit" | "auth" | null;
}

export declare const HARNESSES: Readonly<Record<"claude-code" | "codex" | "gemini", HarnessSpec>>;

export declare function classifyUnavailable(text: string): "usage-limit" | "auth" | null;

export declare function runHarnessAgent(
  harness: string,
  joinUrl: string,
  options?: { timeoutMs?: number },
): Promise<{
  readonly harness: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly transcriptSha256: string;
  readonly transcriptBytes: number;
  readonly tokens: unknown;
  readonly unavailable: "usage-limit" | "auth" | null;
  readonly stderrTail: string;
}>;
