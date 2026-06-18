import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeSaveWorkspaceContext,
  WebContainerRuntimeSnapshotGetterContext,
  type RunnerConfig,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeRecordingSnapshot,
} from "./WebContainerRuntimeContext";
import { useWorkspaceLessonType } from "../hooks/useWorkspace";
import { WebContainerRuntimeProvider as WebContainerRuntimeProviderContainer } from "./WebContainerRuntimeProviderImpl";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

const fallbackRunnerConfig: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "npm install",
  runCommand: "npm run dev",
};

const noopAsync = async () => undefined;
const noop = () => undefined;

const fallbackActions: WebContainerRuntimeActions = {
  startRuntime: noopAsync,
  resetRuntime: noop,
  rerunRunner: noopAsync,
  runCommand: noopAsync,
  startTerminalSession: noopAsync,
  createTerminalSession: noopAsync,
  closeTerminalSession: noop,
  setActiveTerminalSession: noop,
  sendTerminalInput: noopAsync,
  resizeTerminal: noop,
  saveWorkspace: noopAsync,
  updateEnvironmentVariables: noop,
  updateRunnerConfig: noop,
};

function getIsRuntimeSupported(): boolean {
  return typeof window !== "undefined" && window.crossOriginIsolated;
}

const fallbackSnapshot: WebContainerRuntimeRecordingSnapshot = {
  status: "idle",
  previewUrl: null,
  previewPort: null,
  lastOutput: null,
  activeCommand: null,
  errorMessage: null,
  terminalSessions: [],
  activeTerminalSessionId: null,
};

function getFallbackMetadata(): WebContainerRuntimeMetadata {
  return {
    status: "idle",
    previewUrl: null,
    previewPort: null,
    isSupported: getIsRuntimeSupported(),
    errorMessage: null,
    latestPreviewMessage: null,
    openPorts: [],
    latestLifecycleEvent: null,
    lastOutput: null,
    terminalSessions: [],
    activeTerminalSessionId: null,
    activeCommand: null,
    environmentVariables: {},
    runnerConfig: fallbackRunnerConfig,
    workspaceRoot: "~/projects/next-editor",
  };
}

function StaticWebContainerRuntimeProvider({ children }: WebContainerRuntimeProviderProps) {
  return (
    <WebContainerRuntimeSnapshotGetterContext value={() => fallbackSnapshot}>
      <WebContainerRuntimeSaveWorkspaceContext value={noopAsync}>
        <WebContainerRuntimeActionsContext value={fallbackActions}>
          <WebContainerRuntimeMetadataContext value={getFallbackMetadata()}>
            {children}
          </WebContainerRuntimeMetadataContext>
        </WebContainerRuntimeActionsContext>
      </WebContainerRuntimeSaveWorkspaceContext>
    </WebContainerRuntimeSnapshotGetterContext>
  );
}

export function WebContainerRuntimeProvider({ children }: WebContainerRuntimeProviderProps) {
  const lessonType = useWorkspaceLessonType();

  if (lessonType !== "node.js") {
    return <StaticWebContainerRuntimeProvider>{children}</StaticWebContainerRuntimeProvider>;
  }

  return <WebContainerRuntimeProviderContainer>{children}</WebContainerRuntimeProviderContainer>;
}
