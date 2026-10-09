// The command lines the runtime runs: the runner's default init and run
// commands, the shells a terminal tries, and how a command line is spawned.
import type { RunnerConfig } from "./types";
import { isWorkspaceTextFile, type WorkspaceProject } from "../../types/workspace";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "pnpm install",
  runCommand: "pnpm dev",
};

const WEBCONTAINER_VITE_PLUS_RUN_COMMAND = "npx vite --host 0.0.0.0 --configLoader native";

export const TERMINAL_SHELL_CANDIDATES = [
  { command: "jsh", args: [] },
  { command: "bash", args: ["-i"] },
  { command: "sh", args: ["-i"] },
] as const;

export function parseCommand(commandLine: string): { command: string; args: string[] } | null {
  const command = commandLine.trim();

  if (!command) {
    return null;
  }

  // Runner settings intentionally accept shell command lines. Delegating their
  // grammar to the sandbox shell preserves quotes, escaped/empty arguments,
  // environment assignments, pipes, and redirects without a divergent parser.
  return { command: "sh", args: ["-lc", command] };
}

export function formatCommandError(commandLine: string): string {
  return `"${commandLine}" failed inside the WebContainer runtime`;
}

export function resolveRuntimeRunCommand(
  project: WorkspaceProject | null,
  commandLine: string,
): string {
  const normalizedCommandLine = commandLine.trim();

  if (normalizedCommandLine !== DEFAULT_RUNNER_CONFIG.runCommand) {
    return normalizedCommandLine;
  }

  const packageJsonFile = project?.files["package.json"];

  if (!packageJsonFile || !isWorkspaceTextFile(packageJsonFile)) {
    return normalizedCommandLine;
  }

  try {
    const packageJson = JSON.parse(packageJsonFile.content) as {
      scripts?: Record<string, string | undefined>;
    };
    const devScript = packageJson.scripts?.dev?.trim() ?? "";

    if (devScript === "vp dev" || devScript.startsWith("vp dev ")) {
      return WEBCONTAINER_VITE_PLUS_RUN_COMMAND;
    }
  } catch {
    return normalizedCommandLine;
  }

  return normalizedCommandLine;
}
