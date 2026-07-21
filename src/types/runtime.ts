export type RuntimeDockTab = "runner" | "terminal" | "console" | "agent";
export type RuntimeTerminalScrollLines = Record<string, number>;

export interface RuntimeTerminalSessionSnapshot {
  id: string;
  title: string;
  output: string;
}

export interface RuntimePanelRecordingState {
  activeTab?: RuntimeDockTab;
  isCollapsed?: boolean;
  isFullHeight?: boolean;
  isSettingsOpen?: boolean;
  consoleLines?: string[];
  terminalScrollLines?: RuntimeTerminalScrollLines;
}

export interface RuntimeRecordingSnapshot extends RuntimePanelRecordingState {
  mode: "single-file" | "webcontainer";
  status: string;
  previewUrl?: string | null;
  previewPort?: number | null;
  lastOutput?: string | null;
  activeCommand?: string | null;
  errorMessage?: string | null;
  terminalSessions?: RuntimeTerminalSessionSnapshot[];
  activeTerminalSessionId?: string | null;
  latestPreviewMessage?: {
    id: number;
    kind: "console-error" | "uncaught-exception" | "unhandled-rejection";
    text: string;
    port: number | null;
    pathname: string;
  } | null;
  latestLifecycleEvent?: {
    id: number;
    kind: "port-open" | "port-close" | "internal-error";
    text: string;
    port: number | null;
    url: string | null;
  } | null;
}

export interface RuntimeRecordingEvent {
  timestamp: number;
  snapshot: RuntimeRecordingSnapshot;
}
