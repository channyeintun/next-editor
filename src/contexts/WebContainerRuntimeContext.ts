import { createContext } from "react";

export type WebContainerRuntimeStatus =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "error";

export interface RunnerConfig {
  enabled: boolean;
  runOnStartup: boolean;
  runOnFileSave: boolean;
  initCommand: string;
  runCommand: string;
}

export interface WebContainerRuntimeActions {
  startRuntime: () => Promise<void>;
  resetRuntime: () => void;
  rerunRunner: () => Promise<void>;
  runCommand: (commandLine: string) => Promise<void>;
  saveWorkspace: () => Promise<void>;
  updateRunnerConfig: (config: Partial<RunnerConfig>) => void;
}

export interface WebContainerRuntimeMetadata {
  status: WebContainerRuntimeStatus;
  previewUrl: string | null;
  isSupported: boolean;
  errorMessage: string | null;
  lastOutput: string | null;
  activeCommand: string | null;
  runnerConfig: RunnerConfig;
  workspaceRoot: string;
}

export const WebContainerRuntimeActionsContext =
  createContext<WebContainerRuntimeActions | null>(null);

export const WebContainerRuntimeMetadataContext =
  createContext<WebContainerRuntimeMetadata | null>(null);
