export type RuntimeDockTab = "runner" | "terminal" | "console";
export type RuntimeTerminalScrollLines = Record<string, number>;

export interface RuntimeTerminalSessionSnapshot {
  id: string;
  title: string;
  output: string;
}

export interface RuntimePanelRecordingState {
  activeTab?: RuntimeDockTab;
  isCollapsed?: boolean;
  isSettingsOpen?: boolean;
  consoleLines?: string[];
  terminalScrollLines?: RuntimeTerminalScrollLines;
}

export interface RuntimeRecordingSnapshot extends RuntimePanelRecordingState {
  mode: "single-file" | "webcontainer";
  status: string;
  previewUrl?: string | null;
  lastOutput?: string | null;
  activeCommand?: string | null;
  errorMessage?: string | null;
  terminalSessions?: RuntimeTerminalSessionSnapshot[];
  activeTerminalSessionId?: string | null;
}

export interface RuntimeRecordingEvent {
  timestamp: number;
  snapshot: RuntimeRecordingSnapshot;
}
