export const GEMINI_SANDBOX_ENTERED: string;

export function geminiSandboxLaunch(
  argv: readonly string[],
  source?: Readonly<NodeJS.ProcessEnv>,
):
  | { unavailable: "auth" | "privacy-prerequisite" | "binary-unavailable" }
  | { binary: string; argv: string[]; env: Record<string, string> };
