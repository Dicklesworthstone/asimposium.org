/** Types for harness-agent.mjs (the runner is plain Node ESM; tests are TypeScript). */
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { CodexExecTokenUsage, CodexPromotionTokenUsage } from "./token-accounting-codex.ts";

export type HarnessSpawnProcess = (
  binary: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface HarnessSpec {
  readonly binary: string;
  argv(prompt: string): string[];
  tokens(stdout: string): unknown;
  unavailable(stdout: string, stderr: string): "usage-limit" | "auth" | null;
  /** Inspect structured CLI start errors even if the process exits zero. */
  readonly reportsStartFailureOnSuccess?: boolean;
  readonly privacyUnavailable?: boolean;
}

export declare const HARNESSES: Readonly<
  Record<"claude-code" | "codex" | "gemini" | "grok", HarnessSpec>
>;

export declare function classifyUnavailable(text: string): "usage-limit" | "auth" | null;

export declare function sponsorPasteBlock(joinUrl: string): string;

export declare function retainedRouteTemplate(path: string): string;

export declare function harnessUsageDetails(
  harness: string,
  stdout: string,
): Record<string, number | boolean | string> | null;

export declare function startCodexUsageCollector(): Promise<{
  readonly argv: readonly string[];
  usage(
    whole: CodexExecTokenUsage | null,
    firstPromotionAt: number | undefined,
  ): CodexPromotionTokenUsage | null;
  close(): Promise<void>;
}>;

export declare function runHarnessAgent(
  harness: string,
  joinUrl: string,
  options?: {
    timeoutMs?: number;
    spawnProcess?: HarnessSpawnProcess;
    firstPromotionAt?: () => number | undefined;
  },
): Promise<{
  readonly harness: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly transcriptSha256: string;
  readonly transcriptBytes: number;
  readonly transcriptTruncated: boolean;
  readonly tokens: unknown;
  readonly tokenUsage: Record<string, number | boolean | string> | null;
  readonly firstPromotionTokenUsage?: CodexPromotionTokenUsage | null;
  readonly stdinWriteFailed: boolean;
  readonly unavailable:
    | "usage-limit"
    | "auth"
    | "privacy-prerequisite"
    | "binary-unavailable"
    | null;
  readonly stderrSha256: string;
  readonly stderrBytes: number;
}>;
