import { createContext } from "react";
import type { RuntimeTerminalSessionSnapshot } from "../types/runtime";

export type WebContainerRuntimeStatus =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "starting"
  | "ready"
  | "error";

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

export type RuntimeLifecycleEventKind = "port-open" | "port-close" | "internal-error";

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
  /** Empties the runner console. Not a reset: the process and runtime survive. */
  clearRunnerOutput: () => void;
  rerunRunner: () => Promise<void>;
  runCommand: (commandLine: string) => Promise<void>;
  startTerminalSession: () => Promise<void>;
  createTerminalSession: () => Promise<void>;
  closeTerminalSession: (sessionId: string) => void;
  setActiveTerminalSession: (sessionId: string) => void;
  sendTerminalInput: (input: string) => Promise<void>;
  resizeTerminal: (size: { cols: number; rows: number }) => void;
  updateEnvironmentVariables: (variables: EnvironmentVariables) => void;
  updateRunnerConfig: (config: Partial<RunnerConfig>) => void;
  /** Applies an ephemeral, complete Studio contract without persisting it as a user setting. */
  configureRuntime: (configuration: {
    environmentVariables: EnvironmentVariables;
    runnerConfig: RunnerConfig;
  }) => void;
  /**
   * Turns on or off the reverse sync, which pulls files a container process
   * writes back into the workspace. CollaborationProvider turns it off while a
   * live room owns the workspace: the room is the project's source of truth and
   * the container only mirrors it (docs/live-collaboration.md), so container
   * output stays in this browser's container.
   */
  setReverseSyncEnabled: (enabled: boolean) => void;
}

export interface WebContainerRuntimeRecordingSnapshot {
  status: WebContainerRuntimeStatus;
  previewUrl: string | null;
  previewPort: number | null;
  lastOutput: string | null;
  activeCommand: string | null;
  errorMessage: string | null;
  terminalSessions: RuntimeTerminalSessionSnapshot[];
  activeTerminalSessionId: string | null;
  latestPreviewMessage: RuntimePreviewMessage | null;
  latestLifecycleEvent: RuntimeLifecycleEvent | null;
}

/**
 * The runner console and the terminal sessions' text: the fields that change on
 * every output chunk, so they have a context of their own and only the
 * components that render output re-render while a process streams.
 */
export type WebContainerRuntimeOutput = Pick<
  WebContainerRuntimeRecordingSnapshot,
  "lastOutput" | "terminalSessions"
>;

/**
 * Everything a recording snapshot holds except the streaming output, plus the
 * runtime's support and settings.
 */
export interface WebContainerRuntimeMetadata extends Omit<
  WebContainerRuntimeRecordingSnapshot,
  keyof WebContainerRuntimeOutput
> {
  isSupported: boolean;
  environmentVariables: EnvironmentVariables;
  runnerConfig: RunnerConfig;
  /** False on /studio: only typed plan actions may start the runtime there. */
  ambientStartEnabled: boolean;
}

export const WebContainerRuntimeActionsContext = createContext<WebContainerRuntimeActions | null>(
  null,
);
export interface SaveWorkspaceOptions {
  /**
   * Skip the run-on-save rerun when the runner last ran exactly this project (a replay
   * re-saving the workspace it shows). An explicit save always reruns.
   */
  rerunOnlyIfChanged?: boolean;
}

export const WebContainerRuntimeSaveWorkspaceContext = createContext<
  ((options?: SaveWorkspaceOptions) => Promise<void>) | null
>(null);
export const WebContainerRuntimeSnapshotGetterContext = createContext<
  (() => WebContainerRuntimeRecordingSnapshot) | null
>(null);

export const WebContainerRuntimeMetadataContext = createContext<WebContainerRuntimeMetadata | null>(
  null,
);
export const WebContainerRuntimeOutputContext = createContext<WebContainerRuntimeOutput | null>(
  null,
);
