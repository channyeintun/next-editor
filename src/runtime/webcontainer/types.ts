import type { RuntimeStatus } from "../../types/runtime";

/** The recorded status union, which core owns because recordings store it. */
export type WebContainerRuntimeStatus = RuntimeStatus;

/** A boot, mount, install or runner start is under way. */
export function isRuntimeBusy(status: WebContainerRuntimeStatus): boolean {
  return (
    status === "booting" ||
    status === "mounting" ||
    status === "installing" ||
    status === "starting"
  );
}

export interface RunnerConfig {
  enabled: boolean;
  runOnStartup: boolean;
  runOnFileSave: boolean;
  initCommand: string;
  runCommand: string;
}

export type EnvironmentVariables = Record<string, string>;
