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

export type EnvironmentVariables = Record<string, string>;

export type RuntimePreviewMessageKind =
  | "console-error"
  | "uncaught-exception"
  | "unhandled-rejection";

export interface RuntimePreviewMessage {
  id: number;
  kind: RuntimePreviewMessageKind;
  text: string;
  port: number | null;
  pathname: string;
}

export interface RuntimePort {
  port: number;
  url: string;
}

export type RuntimeLifecycleEventKind =
  | "port-open"
  | "port-close"
  | "internal-error";

export interface RuntimeLifecycleEvent {
  id: number;
  kind: RuntimeLifecycleEventKind;
  text: string;
  port: number | null;
  url: string | null;
}

export interface WebContainerRuntimeActions {
  startRuntime: () => Promise<void>;
  resetRuntime: () => void;
  rerunRunner: () => Promise<void>;
  runCommand: (commandLine: string) => Promise<void>;
  startTerminalSession: () => Promise<void>;
  sendTerminalInput: (input: string) => Promise<void>;
  resizeTerminal: (size: { cols: number; rows: number }) => void;
  saveWorkspace: () => Promise<void>;
  updateEnvironmentVariables: (variables: EnvironmentVariables) => void;
  updateRunnerConfig: (config: Partial<RunnerConfig>) => void;
}

export interface WebContainerRuntimeMetadata {
  status: WebContainerRuntimeStatus;
  previewUrl: string | null;
  isSupported: boolean;
  errorMessage: string | null;
  latestPreviewMessage: RuntimePreviewMessage | null;
  openPorts: RuntimePort[];
  latestLifecycleEvent: RuntimeLifecycleEvent | null;
  lastOutput: string | null;
  terminalOutput: string | null;
  activeCommand: string | null;
  environmentVariables: EnvironmentVariables;
  runnerConfig: RunnerConfig;
  workspaceRoot: string;
}

export const WebContainerRuntimeActionsContext =
  createContext<WebContainerRuntimeActions | null>(null);

export const WebContainerRuntimeMetadataContext =
  createContext<WebContainerRuntimeMetadata | null>(null);
